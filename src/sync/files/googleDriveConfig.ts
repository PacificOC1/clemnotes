/**
 * Google Drive settings and the pure parts of its sign-in (tested without a
 * browser).
 *
 * The OAuth client lives in a Google Cloud project; its *ID* goes in the
 * build (`VITE_GOOGLE_CLIENT_ID`), its *secret* only in the Supabase Edge
 * Function that keeps the connection alive (see
 * `supabase/functions/google-drive`).
 */

export type GoogleDriveConfigCheck =
  | { ok: true; clientId: string }
  | { ok: false; absent: boolean; problem: string };

const CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export function checkGoogleDriveConfig(raw: string | undefined): GoogleDriveConfigCheck {
  const clientId = (raw ?? '').trim();
  if (!clientId) return { ok: false, absent: true, problem: 'Google Drive is not set up in this build.' };
  if (!CLIENT_ID.test(clientId)) {
    return {
      ok: false,
      absent: false,
      problem:
        'VITE_GOOGLE_CLIENT_ID should be the OAuth client ID from Google Cloud — it ends in .apps.googleusercontent.com (not the client secret).',
    };
  }
  return { ok: true, clientId };
}

/** Only the hidden app-data folder, plus who you are (to show the account). */
export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.appdata'];

/** Sign-ins Clemnotes starts carry this, so the return trip can't be mistaken for Microsoft's. */
export const GOOGLE_STATE_PREFIX = 'gd.';

export function isGoogleSignInResponse(search: string): boolean {
  const params = new URLSearchParams(search);
  return (params.get('state') ?? '').startsWith(GOOGLE_STATE_PREFIX) && (params.has('code') || params.has('error'));
}

export function googleAuthUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    // A refresh token, every time: it's the whole point of the function.
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (options.loginHint) params.set('login_hint', options.loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** URL-safe base64 without padding, as PKCE wants it. */
export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}
