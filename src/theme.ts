/**
 * Light, dark, or whatever the system says (#57).
 *
 * Stored per device in `localStorage` — a phone read in daylight and a laptop
 * used at night can reasonably disagree — and applied to <html> as
 * `data-theme` before React renders, so there is no flash of the wrong one.
 * Dark stays the default: it is what the app has always looked like.
 */

export type ThemePreference = 'dark' | 'light' | 'system';

const KEY = 'clemnotes:theme';
const listeners = new Set<(pref: ThemePreference) => void>();
let media: MediaQueryList | null = null;

export function loadTheme(): ThemePreference {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw === 'light' || raw === 'system' || raw === 'dark' ? raw : 'dark';
  } catch {
    return 'dark';
  }
}

function resolve(pref: ThemePreference): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function paint(pref: ThemePreference): void {
  document.documentElement.dataset.theme = resolve(pref);
}

/** Apply the saved preference, and follow the system while it is "system". */
export function applyStoredTheme(): void {
  const pref = loadTheme();
  paint(pref);
  media ??= globalThis.matchMedia?.('(prefers-color-scheme: light)') ?? null;
  media?.addEventListener('change', () => {
    if (loadTheme() === 'system') paint('system');
  });
}

export function setTheme(pref: ThemePreference): void {
  try {
    globalThis.localStorage?.setItem(KEY, pref);
  } catch {
    // Not remembered, but still applied for this visit.
  }
  paint(pref);
  for (const listener of listeners) listener(pref);
}

export function onThemeChange(listener: (pref: ThemePreference) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const NEXT_THEME: Record<ThemePreference, ThemePreference> = {
  dark: 'light',
  light: 'system',
  system: 'dark',
};
