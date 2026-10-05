import { getSupabase } from '../supabaseClient';
import { googleDriveConfig, notifyFileStoreChanged } from './fileStoreState';
import { googleAuthUrl, GOOGLE_STATE_PREFIX, pkceChallenge, randomToken } from './googleDriveConfig';
import { redirectUriFor } from './oneDriveConfig';
import { FileStoreError } from './types';
import { logEvent } from '../../diagnostics';

/**
 * The Google Drive connection.
 *
 * Google gives a browser-only app about an hour of Drive access at a time.
 * To stay connected, the lasting part of the sign-in (a refresh token) is
 * kept by the `google-drive` Supabase Edge Function, next to the Google client
 * secret; the browser only ever holds short-lived access tokens, which it asks
 * the function for.
 *
 * Because the refresh token belongs to your *Clemnotes* account, connecting
 * once connects every device you're signed in to sync on — a new phone needs
 * no Google sign-in of its own.
 *
 * Sign-in is a redirect (reliable on phones), with PKCE, and a state that
 * starts `gd.` so `main.tsx` can tell Google's return from Microsoft's.
 */

const SIGN_IN_KEY = 'clemnotes:gdrive-signin';
const FUNCTION = 'google-drive';
/** After the function says "not connected", don't ask again for this long (another device may connect meanwhile). */
const RECHECK_MS = 5 * 60 * 1000;

let cached: { token: string; expiresAt: number; email: string | null } | null = null;
let inFlight: Promise<string> | null = null;
let notConnectedAt = 0;
let lastSignInError: string | null = null;

function redirectUri(): string {
  return redirectUriFor(window.location.origin, import.meta.env.BASE_URL);
}

interface FunctionReply {
  accessToken?: string;
  expiresIn?: number;
  email?: string | null;
}

async function callFunction(body: Record<string, string>): Promise<FunctionReply> {
  const supabase = await getSupabase();
  if (!supabase) throw new FileStoreError('not-configured', 'Cloud sync is not configured.');
  const { data, error } = await supabase.functions.invoke<FunctionReply>(FUNCTION, { body });
  if (!error) return data ?? {};

  const context = (error as { context?: unknown }).context;
  let payload: { error?: string; message?: string; msg?: string } = {};
  let status = 0;
  if (context instanceof Response) {
    status = context.status;
    payload = (await context.clone().json().catch(() => ({}))) as typeof payload;
  }
  if (payload.error === 'needs-sign-in' || payload.error === 'not-signed-in') {
    throw new FileStoreError('needs-sign-in', payload.message ?? 'Connect Google Drive first.');
  }
  if (status === 404 && !payload.error) {
    throw new FileStoreError(
      'failed',
      'The google-drive function isn’t deployed in your Supabase project yet — see “Google Drive for images and PDFs” in the README.'
    );
  }
  if (error.name === 'FunctionsFetchError') {
    throw new FileStoreError('failed', "Can't reach Supabase — you may be offline.");
  }
  throw new FileStoreError('failed', payload.message ?? payload.msg ?? error.message);
}

function remember(reply: FunctionReply): string {
  if (!reply.accessToken) throw new FileStoreError('failed', 'The google-drive function returned no token.');
  cached = {
    token: reply.accessToken,
    expiresAt: Date.now() + (reply.expiresIn ?? 3600) * 1000,
    email: reply.email ?? null,
  };
  notConnectedAt = 0;
  return reply.accessToken;
}

/**
 * A Drive access token, from memory while it's fresh, otherwise from the
 * function. Throws `needs-sign-in` when Drive isn't connected (or no longer).
 * `force` skips the cached one — for when Drive turned it down.
 */
export async function getGoogleDriveToken(force = false): Promise<string> {
  if (!googleDriveConfig.ok) throw new FileStoreError('not-configured', googleDriveConfig.problem);
  if (!force && cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  if (!force && notConnectedAt && Date.now() - notConnectedAt < RECHECK_MS) {
    throw new FileStoreError('needs-sign-in', 'Connect Google Drive to sync files.');
  }
  inFlight ??= callFunction({ action: 'token' })
    .then(remember)
    .catch((err: unknown) => {
      if (err instanceof FileStoreError && err.code === 'needs-sign-in') {
        cached = null;
        notConnectedAt = Date.now();
      }
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export interface GoogleDriveAccount {
  email: string | null;
}

/** The connected Google account, or null when Drive isn't connected. */
export async function getGoogleDriveAccount(): Promise<GoogleDriveAccount | null> {
  try {
    await getGoogleDriveToken();
    return { email: cached?.email ?? null };
  } catch (err) {
    if (err instanceof FileStoreError && err.code === 'needs-sign-in') return null;
    throw err;
  }
}

/** Why the last sign-in didn't work, once — then forgotten. */
export function takeGoogleSignInError(): string | null {
  const error = lastSignInError;
  lastSignInError = null;
  return error;
}

/** Leave for Google's sign-in page; where you were comes back with you. */
export async function signInToGoogleDrive(): Promise<void> {
  if (!googleDriveConfig.ok) throw new FileStoreError('not-configured', googleDriveConfig.problem);
  const state = `${GOOGLE_STATE_PREFIX}${randomToken(16)}`;
  const verifier = randomToken(48);
  sessionStorage.setItem(SIGN_IN_KEY, JSON.stringify({ state, verifier, hash: window.location.hash }));
  const url = googleAuthUrl({
    clientId: googleDriveConfig.clientId,
    redirectUri: redirectUri(),
    state,
    codeChallenge: await pkceChallenge(verifier),
  });
  // Focus leaves the editor first so a pending edit is written.
  (document.activeElement as HTMLElement | null)?.blur?.();
  await new Promise((resolve) => setTimeout(resolve, 400));
  window.location.assign(url);
}

/**
 * On the way back from Google (called by `main.tsx` before the app loads):
 * hand the code to the function, then put the address back.
 */
export async function completeGoogleDriveSignIn(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  let saved: { state?: string; verifier?: string; hash?: string } = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(SIGN_IN_KEY) ?? '{}') as typeof saved;
    sessionStorage.removeItem(SIGN_IN_KEY);
  } catch {
    // Treated as a mismatch below.
  }

  const error = params.get('error');
  const code = params.get('code');
  try {
    if (error) {
      lastSignInError = error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google said: ${error}`;
    } else if (!code || !saved.state || params.get('state') !== saved.state || !saved.verifier) {
      lastSignInError = 'That Google sign-in didn’t match one started here — try again.';
    } else {
      const reply = await callFunction({
        action: 'exchange',
        code,
        redirectUri: redirectUri(),
        codeVerifier: saved.verifier,
      });
      remember(reply);
      logEvent('files', 'Connected Google Drive');
    }
  } catch (err) {
    lastSignInError = err instanceof Error ? err.message : String(err);
    logEvent('files', `Google Drive sign-in failed: ${lastSignInError}`, undefined, 'warn');
  }
  window.history.replaceState(null, '', `${window.location.pathname}${saved.hash ?? ''}`);
}

/**
 * Disconnect Google Drive — for this Clemnotes account, so on every device.
 * The access is revoked at Google too. Files already on devices stay there.
 */
export async function disconnectGoogleDrive(): Promise<void> {
  await callFunction({ action: 'disconnect' });
  cached = null;
  notConnectedAt = Date.now();
  logEvent('files', 'Disconnected Google Drive');
  notifyFileStoreChanged();
}

/** Tests: forget everything held in memory. */
export function resetGoogleDriveAuthForTests(): void {
  cached = null;
  inFlight = null;
  notConnectedAt = 0;
  lastSignInError = null;
}
