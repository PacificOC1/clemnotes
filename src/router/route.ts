/**
 * Where you are, as a value.
 *
 * The app used to keep this in React state, which meant the browser's back
 * button did nothing, a reload dropped you back at the first page, and a
 * zoomed rem had no address you could send anyone. Putting it in the URL fixes
 * all three at once — but only if the URL is the single source of truth rather
 * than something kept in step with state that lives elsewhere.
 *
 * The route lives in the *hash*. GitHub Pages serves static files with no SPA
 * fallback, so a real path like `/clemnotes/rem/abc` would 404 on reload — the
 * one case this change is most meant to fix.
 */

export type AppTab = 'notes' | 'review' | 'dictionary';

export interface Route {
  tab: AppTab;
  /** The rem being zoomed into, on the notes tab. */
  nodeId: string | null;
  /** A second document open beside it (#43). Absent, not null, when there isn't one. */
  splitId?: string;
}

export const HOME: Route = { tab: 'notes', nodeId: null };

const TABS: AppTab[] = ['notes', 'review', 'dictionary'];

function isTab(value: string): value is AppTab {
  return (TABS as string[]).includes(value);
}

/**
 * Read a route out of a hash. Anything unrecognised reads as the notes tab,
 * because a URL someone mistyped should land them somewhere usable rather than
 * on an error.
 */
export function parseRoute(hash: string): Route {
  const segments = hash
    .replace(/^#/, '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  const [head, ...rest] = segments;
  if (!head) return { ...HOME };
  if (!isTab(head)) return { ...HOME };
  if (head !== 'notes') return { tab: head, nodeId: null };

  const raw = rest[0];
  if (!raw) return { ...HOME };
  try {
    const nodeId = decodeURIComponent(raw);
    // `#/notes/<id>/split/<other>` — two documents side by side.
    if (rest[1] === 'split' && rest[2]) return { tab: 'notes', nodeId, splitId: decodeURIComponent(rest[2]) };
    return { tab: 'notes', nodeId };
  } catch {
    // A malformed percent-escape shouldn't be a dead end.
    return { ...HOME };
  }
}

/** The canonical hash for a route. Always absolute, always with a leading `#/`. */
export function formatRoute(route: Route): string {
  if (route.tab !== 'notes') return `#/${route.tab}`;
  if (!route.nodeId) return '#/notes';
  const main = `#/notes/${encodeURIComponent(route.nodeId)}`;
  return route.splitId ? `${main}/split/${encodeURIComponent(route.splitId)}` : main;
}

/** True when two routes point at the same place — used to avoid junk history entries. */
export function sameRoute(a: Route, b: Route): boolean {
  return a.tab === b.tab && a.nodeId === b.nodeId && (a.splitId ?? null) === (b.splitId ?? null);
}
