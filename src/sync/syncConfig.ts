/**
 * Is the Supabase configuration something that could possibly work?
 *
 * "Both variables are non-empty" was the whole test, so the untouched template
 * values passed it: the sidebar showed a working-looking sign-in form, and
 * signing in failed with a bare "Failed to fetch" — a DNS error for a host
 * that does not exist, shown as though the password were wrong. This catches
 * that before a form is drawn, and says which variable to fix.
 *
 * Pure, so it can be tested without a build that bakes env vars in.
 */

export type SyncConfigCheck =
  | { ok: true; url: string; anonKey: string }
  | { ok: false; problem: string; /** Nothing was set at all — the normal local-only case. */ absent: boolean };

/**
 * Substrings that only ever appear in a template, never in a real value. The
 * key's list is narrower than the URL's on purpose: a real key is a long run
 * of base64, and a short hint like "xxxx" could turn up in one by chance.
 */
const URL_PLACEHOLDERS = ['your-project', 'your_project', 'project-ref', 'example', 'xxxx', '<', 'changeme'];
const KEY_PLACEHOLDERS = ['your-anon', 'your_anon', 'anon-public-key', 'anon_key_here', '<', 'changeme'];

function looksLikePlaceholder(value: string, hints: string[]): boolean {
  const lower = value.toLowerCase();
  return hints.some((hint) => lower.includes(hint));
}

export function checkSyncConfig(
  rawUrl: string | undefined,
  rawKey: string | undefined
): SyncConfigCheck {
  const url = (rawUrl ?? '').trim();
  const anonKey = (rawKey ?? '').trim();

  if (!url && !anonKey) {
    return { ok: false, absent: true, problem: 'Cloud sync not configured' };
  }
  if (!url) {
    return { ok: false, absent: false, problem: 'VITE_SUPABASE_URL is missing — set it alongside the anon key.' };
  }
  if (!anonKey) {
    return { ok: false, absent: false, problem: 'VITE_SUPABASE_ANON_KEY is missing — set it alongside the URL.' };
  }

  if (looksLikePlaceholder(url, URL_PLACEHOLDERS)) {
    return {
      ok: false,
      absent: false,
      problem: 'VITE_SUPABASE_URL is still the template value. Use your Project URL from Supabase → Project Settings → API.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, absent: false, problem: `VITE_SUPABASE_URL isn't a URL: "${url}".` };
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    return { ok: false, absent: false, problem: 'VITE_SUPABASE_URL should start with https://.' };
  }
  // A hosted project is `<ref>.supabase.co`; a self-hosted one can be anything
  // with a dot in it. A bare word is almost always a typo or half a value.
  if (!local && !parsed.hostname.includes('.')) {
    return { ok: false, absent: false, problem: `VITE_SUPABASE_URL's host "${parsed.hostname}" doesn't look like a real address.` };
  }

  if (looksLikePlaceholder(anonKey, KEY_PLACEHOLDERS)) {
    return {
      ok: false,
      absent: false,
      problem: 'VITE_SUPABASE_ANON_KEY is still the template value. Use the anon/public key from Supabase → Project Settings → API.',
    };
  }
  // Supabase keys are long — a JWT, or a `sb_publishable_…` key. Anything
  // short is a fragment pasted by mistake.
  if (anonKey.length < 30) {
    return { ok: false, absent: false, problem: "VITE_SUPABASE_ANON_KEY is too short to be a Supabase key — check it wasn't cut off." };
  }

  return { ok: true, url, anonKey };
}

/**
 * Translate a failed request into something actionable.
 *
 * `fetch` rejects with a `TypeError` ("Failed to fetch", "NetworkError when
 * attempting to fetch resource", "Load failed" depending on the browser) when
 * the host cannot be reached at all — offline, blocked, or a URL that points
 * nowhere. None of those are about your password.
 */
export function describeNetworkError(err: unknown, online = typeof navigator === 'undefined' || navigator.onLine): string {
  const message = err instanceof Error ? err.message : String(err);
  const isNetwork =
    err instanceof TypeError ||
    /failed to fetch|networkerror|load failed|network request failed/i.test(message);
  if (!isNetwork) return message || 'Something went wrong — please try again.';
  if (!online) return "You're offline — sync will pick up again when you're back.";
  return "Can't reach your Supabase project. Check VITE_SUPABASE_URL, and that the project isn't paused.";
}
