import { describe, expect, it } from 'vitest';
import { DRIVE_SCOPE, emailFromIdToken, handle, type Env } from '../../../supabase/functions/google-drive/index.ts';

/**
 * The `google-drive` Edge Function, run in Node against fake Supabase and
 * fake Google endpoints.
 */

const env: Env = {
  supabaseUrl: 'https://proj.supabase.co',
  serviceKey: 'eyJservice',
  googleClientId: 'client.apps.googleusercontent.com',
  googleClientSecret: 'shh',
};

const b64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const idToken = (claims: object) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;

function world(options: { googleError?: string; scope?: string; noRefresh?: boolean } = {}) {
  const rows = new Map<string, { refreshToken: string; email: string | null }>();
  const google: URLSearchParams[] = [];
  const revoked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname === '/auth/v1/user') {
      return headers.get('Authorization') === 'Bearer user-jwt'
        ? Response.json({ id: 'user-1' })
        : Response.json({ msg: 'bad jwt' }, { status: 401 });
    }
    if (url.pathname === '/rest/v1/google_drive_tokens') {
      expect(headers.get('apikey')).toBe('eyJservice');
      const userId = url.searchParams.get('userId')?.replace('eq.', '');
      if (init?.method === 'POST') {
        const row = JSON.parse(String(init.body)) as { userId: string; refreshToken: string; email: string | null };
        rows.set(row.userId, { refreshToken: row.refreshToken, email: row.email });
        return new Response(null, { status: 201 });
      }
      if (init?.method === 'DELETE') {
        rows.delete(userId!);
        return new Response(null, { status: 204 });
      }
      const row = rows.get(userId!);
      return Response.json(row ? [row] : []);
    }
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      google.push(body);
      if (options.googleError) return Response.json({ error: options.googleError }, { status: 400 });
      return Response.json({
        access_token: `access-${google.length}`,
        expires_in: 3599,
        scope: options.scope ?? `openid ${DRIVE_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
        ...(body.get('grant_type') === 'authorization_code'
          ? {
              ...(options.noRefresh ? {} : { refresh_token: 'refresh-1' }),
              id_token: idToken({ email: 'me@gmail.com' }),
            }
          : {}),
      });
    }
    if (url.href === 'https://oauth2.googleapis.com/revoke') {
      revoked.push(new URLSearchParams(String(init?.body)).get('token')!);
      return new Response(null, { status: 200 });
    }
    return new Response('unexpected ' + url.href, { status: 500 });
  }) as typeof fetch;
  return { rows, google, revoked, fetchImpl };
}

const call = (body: unknown, jwt = 'user-jwt') =>
  new Request('https://proj.supabase.co/functions/v1/google-drive', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the google-drive function', () => {
  it('finishes a sign-in: keeps the refresh token, hands back only an access token', async () => {
    const w = world();
    const response = await handle(
      call({ action: 'exchange', code: 'code-1', redirectUri: 'https://me.github.io/clemnotes/', codeVerifier: 'v' }),
      env,
      w.fetchImpl
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ accessToken: 'access-1', expiresIn: 3599, email: 'me@gmail.com' });
    expect(JSON.stringify(body)).not.toContain('refresh');
    expect(w.rows.get('user-1')).toEqual({ refreshToken: 'refresh-1', email: 'me@gmail.com' });
    const sent = w.google[0]!;
    expect(sent.get('client_secret')).toBe('shh');
    expect(sent.get('code_verifier')).toBe('v');
    expect(sent.get('redirect_uri')).toBe('https://me.github.io/clemnotes/');
  });

  it('refuses a sign-in where the Drive box was unticked', async () => {
    const w = world({ scope: 'openid email' });
    const response = await handle(call({ action: 'exchange', code: 'c', redirectUri: 'https://x/' }), env, w.fetchImpl);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('no-drive-scope');
    expect(w.rows.size).toBe(0);
  });

  it('refuses a sign-in that gave no lasting access', async () => {
    const w = world({ noRefresh: true });
    const response = await handle(call({ action: 'exchange', code: 'c', redirectUri: 'https://x/' }), env, w.fetchImpl);
    expect((await response.json()).error).toBe('no-refresh-token');
  });

  it('hands out fresh access tokens from the kept refresh token', async () => {
    const w = world();
    w.rows.set('user-1', { refreshToken: 'refresh-1', email: 'me@gmail.com' });
    const response = await handle(call({ action: 'token' }), env, w.fetchImpl);
    expect(await response.json()).toEqual({ accessToken: 'access-1', expiresIn: 3599, email: 'me@gmail.com' });
    expect(w.google[0]!.get('grant_type')).toBe('refresh_token');
    expect(w.google[0]!.get('refresh_token')).toBe('refresh-1');
  });

  it('asks for a new sign-in when nothing is kept, or Google has ended the access', async () => {
    const empty = world();
    const none = await handle(call({ action: 'token' }), env, empty.fetchImpl);
    expect(none.status).toBe(401);
    expect((await none.json()).error).toBe('needs-sign-in');

    const revoked = world({ googleError: 'invalid_grant' });
    revoked.rows.set('user-1', { refreshToken: 'old', email: null });
    const ended = await handle(call({ action: 'token' }), env, revoked.fetchImpl);
    expect((await ended.json()).error).toBe('needs-sign-in');
    expect(revoked.rows.size).toBe(0);
  });

  it('disconnects: revokes at Google and forgets', async () => {
    const w = world();
    w.rows.set('user-1', { refreshToken: 'refresh-1', email: null });
    const response = await handle(call({ action: 'disconnect' }), env, w.fetchImpl);
    expect(response.status).toBe(200);
    expect(w.revoked).toEqual(['refresh-1']);
    expect(w.rows.size).toBe(0);
  });

  it('only serves signed-in Clemnotes users, and answers the browser’s preflight', async () => {
    const w = world();
    expect((await handle(call({ action: 'token' }, 'forged'), env, w.fetchImpl)).status).toBe(401);
    const preflight = await handle(new Request('https://x/', { method: 'OPTIONS' }), env, w.fetchImpl);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('authorization');
  });

  it('says which secrets are missing', async () => {
    const response = await handle(call({ action: 'token' }), { ...env, googleClientSecret: '' }, world().fetchImpl);
    expect((await response.json()).error).toBe('not-configured');
  });

  it('reads the email from an ID token', () => {
    expect(emailFromIdToken(idToken({ email: 'a@b.c' }))).toBe('a@b.c');
    expect(emailFromIdToken('nonsense')).toBeNull();
    expect(emailFromIdToken(undefined)).toBeNull();
  });
});
