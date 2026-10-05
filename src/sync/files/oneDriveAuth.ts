import type { AccountInfo, IPublicClientApplication } from '@azure/msal-browser';
import { notifyFileStoreChanged, oneDriveConfig } from './fileStoreState';
import { ONEDRIVE_SCOPES, redirectUriFor } from './oneDriveConfig';
import { FileStoreError } from './types';
import { logEvent } from '../../diagnostics';

/**
 * Signing in to Microsoft, for OneDrive file storage.
 *
 * MSAL (Microsoft's own library) is loaded only when something needs it — a
 * sign-in, an upload or a download while OneDrive is the store — so a
 * notebook that never uses OneDrive never downloads it.
 *
 * **Redirect, not popup.** A popup is unreliable on phones and in installed
 * apps; a redirect works everywhere. Microsoft sends you back with its answer
 * in the query string (`response_mode=query`) so it can't collide with the
 * app's `#/route`, and `main.tsx` finishes the sign-in before the app loads.
 *
 * **Tokens last 24 hours for a web app** (Microsoft's rule for single-page
 * apps, not adjustable). After that MSAL renews them in a hidden frame, which
 * works unless the browser blocks third-party cookies (Safari does). When it
 * can't, uploads wait and the sidebar asks you to sign in again — one click
 * if your browser is still signed in to Microsoft.
 */

const RETURN_KEY = 'clemnotes:onedrive-return';
const AUTHORITY = 'https://login.microsoftonline.com/common';

let msal: Promise<IPublicClientApplication> | null = null;
let lastSignInError: string | null = null;
/**
 * Set once a quiet renewal has failed. Until you sign in (which reloads the
 * page) or out, token requests fail straight away rather than trying a hidden
 * frame again on every sync and every missing image.
 */
let renewalFailed = false;
const EXPIRED = 'Your OneDrive sign-in has expired on this device — sign in again to sync files.';

function redirectUri(): string {
  return redirectUriFor(window.location.origin, import.meta.env.BASE_URL);
}

function getMsal(): Promise<IPublicClientApplication> {
  if (!oneDriveConfig.ok) {
    return Promise.reject(new FileStoreError('not-configured', oneDriveConfig.problem));
  }
  const { clientId } = oneDriveConfig;
  msal ??= import('@azure/msal-browser')
    .then(async (module) => {
      const app = new module.PublicClientApplication({
        auth: {
          clientId,
          // Personal *and* work/school accounts.
          authority: AUTHORITY,
          redirectUri: redirectUri(),
          OIDCOptions: { responseMode: 'query' },
        },
        // localStorage so a sign-in survives closing the tab.
        cache: { cacheLocation: 'localStorage' },
      });
      await app.initialize();
      // Always, not only on a return from Microsoft: a redirect abandoned
      // half-way leaves an "interaction in progress" flag that this clears.
      try {
        const result = await app.handleRedirectPromise({ navigateToLoginRequestUrl: false });
        if (result?.account) {
          app.setActiveAccount(result.account);
          lastSignInError = null;
          logEvent('files', 'Signed in to OneDrive', { tenant: result.account.tenantId ? 'yes' : 'no' });
        }
      } catch (err) {
        lastSignInError = describeSignInError(err);
        logEvent('files', `OneDrive sign-in failed: ${lastSignInError}`, undefined, 'warn');
      }
      return app;
    })
    .catch((err: unknown) => {
      msal = null;
      throw err;
    });
  return msal;
}

function describeSignInError(err: unknown): string {
  const code = (err as { errorCode?: string } | null)?.errorCode ?? '';
  const message = err instanceof Error ? err.message : String(err);
  if (/admin|AADSTS65001|AADSTS90094|consent/i.test(message)) {
    return 'Your organisation needs an administrator to approve Clemnotes before you can use its OneDrive. Try a personal Microsoft account instead, or ask IT.';
  }
  if (code === 'access_denied' || /access_denied|cancel/i.test(message)) {
    return 'Sign-in was cancelled.';
  }
  return message.split('\n')[0] ?? 'Signing in to Microsoft failed.';
}

function currentAccount(app: IPublicClientApplication): AccountInfo | null {
  const active = app.getActiveAccount();
  if (active) return active;
  const [first] = app.getAllAccounts();
  if (first) app.setActiveAccount(first);
  return first ?? null;
}

export interface OneDriveAccount {
  username: string;
  name: string | null;
  /** Work or school, rather than a personal Microsoft account. */
  organisational: boolean;
}

/** Personal accounts all live in this one tenant. */
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

export async function getOneDriveAccount(): Promise<OneDriveAccount | null> {
  if (!oneDriveConfig.ok) return null;
  const account = currentAccount(await getMsal());
  if (!account) return null;
  return {
    username: account.username,
    name: account.name ?? null,
    organisational: account.tenantId !== CONSUMER_TENANT,
  };
}

/** Why the last sign-in didn't work, once — then forgotten. */
export function takeSignInError(): string | null {
  const error = lastSignInError;
  lastSignInError = null;
  return error;
}

/**
 * An access token for Microsoft Graph, without any interaction. Throws a
 * `needs-sign-in` FileStoreError when a sign-in (again) is the only way.
 */
export async function getOneDriveToken(): Promise<string> {
  const app = await getMsal();
  const account = currentAccount(app);
  if (!account) throw new FileStoreError('needs-sign-in', 'Sign in to OneDrive on this device to sync files.');
  if (renewalFailed) throw new FileStoreError('needs-sign-in', EXPIRED);
  try {
    const result = await app.acquireTokenSilent({ scopes: ONEDRIVE_SCOPES, account });
    return result.accessToken;
  } catch (err) {
    // Anything but a network failure means Microsoft wants you to sign in
    // again: an expired refresh token, a renewal blocked by third-party
    // cookie rules, or consent that was withdrawn.
    const code = (err as { errorCode?: string } | null)?.errorCode ?? '';
    if (/network|endpoints_resolution|no_network|post_request_failed|get_request_failed/i.test(code)) {
      throw new FileStoreError('failed', "Can't reach Microsoft — you may be offline.");
    }
    renewalFailed = true;
    logEvent('files', 'OneDrive sign-in expired and could not be renewed quietly', { code: code || null }, 'warn');
    throw new FileStoreError('needs-sign-in', EXPIRED);
  }
}

/**
 * Leave for Microsoft's sign-in page. Where you were is kept and restored on
 * the way back. Focus leaves the editor first so a pending edit is written.
 */
export async function signInToOneDrive(): Promise<void> {
  const app = await getMsal();
  try {
    sessionStorage.setItem(RETURN_KEY, window.location.hash);
  } catch {
    // Without sessionStorage you land on the home page; nothing else is lost.
  }
  (document.activeElement as HTMLElement | null)?.blur?.();
  await new Promise((resolve) => setTimeout(resolve, 400));
  await app.loginRedirect({
    scopes: ONEDRIVE_SCOPES,
    redirectUri: redirectUri(),
    // Always offer the account list — the college account and a personal
    // one are easy to mix up when the browser is signed in to both.
    prompt: 'select_account',
  });
}

/**
 * Forget the Microsoft account on this device (its tokens, not your
 * Microsoft session in the browser). Files already here stay here.
 */
export async function signOutOfOneDrive(): Promise<void> {
  const app = await getMsal();
  const account = currentAccount(app);
  await app.clearCache(account ? { account } : undefined);
  app.setActiveAccount(null);
  renewalFailed = false;
  logEvent('files', 'Signed out of OneDrive');
  notifyFileStoreChanged();
}

/**
 * On the way back from Microsoft: finish the sign-in, then put the address
 * back to the page you left from. Called by `main.tsx` before the app loads.
 */
export async function completeOneDriveSignIn(): Promise<void> {
  try {
    await getMsal();
  } catch (err) {
    lastSignInError = describeSignInError(err);
  }
  let hash = '';
  try {
    hash = sessionStorage.getItem(RETURN_KEY) ?? '';
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // Home page it is.
  }
  window.history.replaceState(null, '', `${window.location.pathname}${hash}`);
}
