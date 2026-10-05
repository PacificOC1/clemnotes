/**
 * Is `VITE_ONEDRIVE_CLIENT_ID` something Microsoft could accept?
 *
 * The value is the "Application (client) ID" of an app registration in the
 * Microsoft Entra admin centre — always a GUID. Pure, like `syncConfig.ts`,
 * so the checks can be tested without baking env vars into a build.
 */

export type OneDriveConfigCheck =
  | { ok: true; clientId: string }
  | { ok: false; absent: boolean; problem: string };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkOneDriveConfig(raw: string | undefined): OneDriveConfigCheck {
  const clientId = (raw ?? '').trim();
  if (!clientId) return { ok: false, absent: true, problem: 'OneDrive is not set up in this build.' };
  if (!GUID.test(clientId)) {
    return {
      ok: false,
      absent: false,
      problem:
        'VITE_ONEDRIVE_CLIENT_ID should be the app’s “Application (client) ID” from the Microsoft Entra admin centre — a code like 1a2b3c4d-…',
    };
  }
  return { ok: true, clientId };
}

/** Only the app's own folder — Clemnotes never asks to see the rest of your OneDrive. */
export const ONEDRIVE_SCOPES = ['Files.ReadWrite.AppFolder'];

/**
 * Where Microsoft sends you back after signing in: the app's own address.
 * Has to be listed, exactly, as a "Single-page application" redirect URI in
 * the app registration.
 */
export function redirectUriFor(origin: string, baseUrl: string): string {
  return `${origin}${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}`;
}

/**
 * Does this URL carry Microsoft's answer to a sign-in? Responses come back in
 * the query string (`response_mode=query`), so they never collide with the
 * app's own `#/route`.
 */
export function isSignInResponse(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has('state') && (params.has('code') || params.has('error'));
}
