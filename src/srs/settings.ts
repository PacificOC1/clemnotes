/**
 * Review session settings.
 *
 * These live in `localStorage` rather than in Dexie on purpose. They are
 * preferences about how you want to study on *this* device, not notes — a
 * phone and a laptop can reasonably want different daily limits — and putting
 * them in a synced table would mean a schema version, a Supabase migration and
 * a merge rule for a handful of numbers. If they ever need to travel between
 * devices, that is the moment to move them, not before.
 */

export interface ReviewSettings {
  /** New cards to introduce per day; `null` means no limit. */
  newPerDay: number | null;
  /** Reviews of already-seen cards per day; `null` means no limit. */
  reviewsPerDay: number | null;
  /** Lapses before a card is called a leech; `null` turns leech detection off. */
  leechThreshold: number | null;
  /** Show at most one card per rem in a session. */
  burySiblings: boolean;
}

/**
 * Twenty new and two hundred reviews is Anki's default and a reasonable
 * starting point: enough that a normal day is never truncated, low enough that
 * coming back from three weeks away gives you a day's work rather than a wall.
 * Eight lapses is the usual leech threshold.
 */
export const DEFAULT_SETTINGS: ReviewSettings = {
  newPerDay: 20,
  reviewsPerDay: 200,
  leechThreshold: 8,
  burySiblings: true,
};

const STORAGE_KEY = 'clemnotes.reviewSettings';

/** A positive integer, `null` for "no limit", or `fallback` if the input is neither. */
function coerceLimit(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : null;
}

/** Fill in anything missing or nonsensical, so a hand-edited value can't break a session. */
export function normalizeSettings(raw: unknown): ReviewSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  const input = raw as Partial<ReviewSettings>;
  return {
    newPerDay: coerceLimit(input.newPerDay, DEFAULT_SETTINGS.newPerDay),
    reviewsPerDay: coerceLimit(input.reviewsPerDay, DEFAULT_SETTINGS.reviewsPerDay),
    leechThreshold: coerceLimit(input.leechThreshold, DEFAULT_SETTINGS.leechThreshold),
    burySiblings:
      typeof input.burySiblings === 'boolean' ? input.burySiblings : DEFAULT_SETTINGS.burySiblings,
  };
}

/** Read the saved settings. Falls back to the defaults anywhere storage is unavailable. */
export function loadSettings(): ReviewSettings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? normalizeSettings(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: ReviewSettings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage disabled or full — the session still runs on the values in memory.
  }
}
