/**
 * Supabase Edge Function `google-drive` — keeps Clemnotes connected to your
 * Google Drive.
 *
 * Google only lets a browser-only app hold a Drive token for about an hour,
 * and getting another needs a tap. A *refresh token* lasts, but it can only be
 * used together with the Google client secret, which must never be in the
 * browser. So this function holds both: the secret as a function secret, and
 * each person's refresh token in `google_drive_tokens` (which only this
 * function can read — see `migration-008-google-drive.sql`). The app asks it
 * for a short-lived access token whenever it needs one, and talks to Drive
 * itself.
 *
 * Actions (POST, JSON body, called with the signed-in user's Supabase JWT):
 *
 * - `exchange` `{ code, redirectUri, codeVerifier }` — finish a Google
 *   sign-in: swap the code for tokens, keep the refresh token.
 * - `token` — a fresh access token (and the Google account's email).
 * - `disconnect` — revoke the refresh token at Google and forget it.
 *
 * Secrets to set (Edge Functions → Secrets): `GOOGLE_CLIENT_ID`,
 * `GOOGLE_CLIENT_SECRET`. `SUPABASE_URL` and the service key are provided by
 * Supabase.
 *
 * No imports, on purpose: it can be pasted into the dashboard's editor as one
 * file, and the app's test suite can run `handle` directly.
 */

export interface Env {
  supabaseUrl: string;
  /** Service-role (or new-style secret) key — bypasses row-level security. */
  serviceKey: string;
  googleClientId: string;
  googleClientSecret: string;
}

type Fetch = typeof fetch;

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const TABLE = 'google_drive_tokens';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

/** `error` is a code the app switches on; `message` is for people. */
function fail(status: number, error: string, message: string): Response {
  return reply({ error, message }, status);
}

function serviceHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = { apikey: env.serviceKey, 'Content-Type': 'application/json' };
  // Legacy service_role keys are JWTs and go in Authorization too; the new
  // `sb_secret_…` keys are accepted in `apikey` alone.
  if (env.serviceKey.startsWith('eyJ')) headers.Authorization = `Bearer ${env.serviceKey}`;
  return headers;
}

/** The Supabase user behind the request's JWT, or null. */
async function userIdFor(req: Request, env: Env, fetchImpl: Fetch): Promise<string | null> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const response = await fetchImpl(`${env.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: env.serviceKey, Authorization: auth },
  });
  if (!response.ok) return null;
  const user = (await response.json()) as { id?: string };
  return user.id ?? null;
}

interface StoredToken {
  refreshToken: string;
  email: string | null;
}

async function readToken(userId: string, env: Env, fetchImpl: Fetch): Promise<StoredToken | null> {
  const response = await fetchImpl(
    `${env.supabaseUrl}/rest/v1/${TABLE}?userId=eq.${encodeURIComponent(userId)}&select=refreshToken,email`,
    { headers: serviceHeaders(env) }
  );
  if (!response.ok) throw new Error(await tableProblem(response));
  const rows = (await response.json()) as StoredToken[];
  return rows[0] ?? null;
}

async function writeToken(userId: string, token: StoredToken, env: Env, fetchImpl: Fetch): Promise<void> {
  const response = await fetchImpl(`${env.supabaseUrl}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: { ...serviceHeaders(env), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ userId, refreshToken: token.refreshToken, email: token.email, updatedAt: Date.now() }),
  });
  if (!response.ok) throw new Error(await tableProblem(response));
}

async function deleteToken(userId: string, env: Env, fetchImpl: Fetch): Promise<void> {
  await fetchImpl(`${env.supabaseUrl}/rest/v1/${TABLE}?userId=eq.${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: serviceHeaders(env),
  });
}

async function tableProblem(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (response.status === 404 || /does not exist|PGRST205|schema cache/i.test(text)) {
    return 'The google_drive_tokens table is missing — run supabase/migration-008-google-drive.sql.';
  }
  return `Database error (${response.status}): ${text.slice(0, 200)}`;
}

/** The email in a Google ID token. Read, not verified: it came straight from Google over TLS. */
export function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='));
    const claims = JSON.parse(json) as { email?: string };
    return claims.email ?? null;
  } catch {
    return null;
  }
}

interface GoogleTokens {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function google(body: Record<string, string>, fetchImpl: Fetch): Promise<{ status: number; tokens: GoogleTokens }> {
  const response = await fetchImpl(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const tokens = (await response.json().catch(() => ({}))) as GoogleTokens;
  return { status: response.status, tokens };
}

export async function handle(req: Request, env: Env, fetchImpl: Fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
  if (!env.googleClientId || !env.googleClientSecret) {
    return fail(500, 'not-configured', 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET under Edge Functions → Secrets.');
  }

  const userId = await userIdFor(req, env, fetchImpl);
  if (!userId) return fail(401, 'not-signed-in', 'Sign in to sync first.');

  let body: { action?: string; code?: string; redirectUri?: string; codeVerifier?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return fail(400, 'bad-request', 'Expected a JSON body.');
  }

  try {
    switch (body.action) {
      case 'exchange': {
        if (!body.code || !body.redirectUri) return fail(400, 'bad-request', 'Missing code or redirectUri.');
        const { status, tokens } = await google(
          {
            code: body.code,
            client_id: env.googleClientId,
            client_secret: env.googleClientSecret,
            redirect_uri: body.redirectUri,
            grant_type: 'authorization_code',
            ...(body.codeVerifier ? { code_verifier: body.codeVerifier } : {}),
          },
          fetchImpl
        );
        if (status !== 200 || !tokens.access_token) {
          return fail(400, 'google', `Google refused the sign-in: ${tokens.error_description ?? tokens.error ?? status}`);
        }
        // Google's consent screen lets people untick individual permissions.
        if (!(tokens.scope ?? '').split(' ').includes(DRIVE_SCOPE)) {
          return fail(403, 'no-drive-scope', 'Drive access wasn’t allowed. Sign in again and leave the Google Drive box ticked.');
        }
        const email = emailFromIdToken(tokens.id_token);
        if (tokens.refresh_token) {
          await writeToken(userId, { refreshToken: tokens.refresh_token, email }, env, fetchImpl);
        } else if (!(await readToken(userId, env, fetchImpl))) {
          // Only sent with access_type=offline & prompt=consent; the app asks for both.
          return fail(400, 'no-refresh-token', 'Google didn’t grant lasting access. Sign in again.');
        }
        return reply({ accessToken: tokens.access_token, expiresIn: tokens.expires_in ?? 3600, email });
      }

      case 'token': {
        const stored = await readToken(userId, env, fetchImpl);
        if (!stored) return fail(401, 'needs-sign-in', 'Connect Google Drive on this account first.');
        const { status, tokens } = await google(
          {
            refresh_token: stored.refreshToken,
            client_id: env.googleClientId,
            client_secret: env.googleClientSecret,
            grant_type: 'refresh_token',
          },
          fetchImpl
        );
        if (tokens.error === 'invalid_grant') {
          // Revoked, expired (an app left in "Testing" loses them after 7 days) or password changed.
          await deleteToken(userId, env, fetchImpl);
          return fail(401, 'needs-sign-in', 'Google Drive access has ended — connect it again.');
        }
        if (status !== 200 || !tokens.access_token) {
          return fail(502, 'google', `Google didn’t hand out a token: ${tokens.error_description ?? tokens.error ?? status}`);
        }
        return reply({ accessToken: tokens.access_token, expiresIn: tokens.expires_in ?? 3600, email: stored.email });
      }

      case 'disconnect': {
        const stored = await readToken(userId, env, fetchImpl);
        if (stored) {
          await fetchImpl(GOOGLE_REVOKE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: stored.refreshToken }).toString(),
          }).catch(() => undefined);
          await deleteToken(userId, env, fetchImpl);
        }
        return reply({ ok: true });
      }

      default:
        return fail(400, 'bad-request', 'Unknown action.');
    }
  } catch (err) {
    return fail(500, 'server', err instanceof Error ? err.message : String(err));
  }
}

// ---- Deno entry point (skipped when the tests import this file) ----

declare const Deno:
  | { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response>): unknown }
  | undefined;

function serviceKeyFromEnv(get: (name: string) => string | undefined): string {
  // New-style keys arrive as a JSON map; fall back to the legacy service_role key.
  const secrets = get('SUPABASE_SECRET_KEYS');
  if (secrets) {
    try {
      const map = JSON.parse(secrets) as Record<string, string>;
      const key = map.default ?? Object.values(map)[0];
      if (key) return key;
    } catch {
      // Not JSON: ignore.
    }
  }
  return get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

if (typeof Deno !== 'undefined') {
  const get = (name: string) => Deno!.env.get(name);
  const env: Env = {
    supabaseUrl: get('SUPABASE_URL') ?? '',
    serviceKey: serviceKeyFromEnv(get),
    googleClientId: get('GOOGLE_CLIENT_ID') ?? '',
    googleClientSecret: get('GOOGLE_CLIENT_SECRET') ?? '',
  };
  Deno.serve((req) => handle(req, env));
}
