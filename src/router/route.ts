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

export type AppTab = 'notes' | 'review' | 'dictionary' | 'courses';

export interface Route {
  tab: AppTab;
  /** The rem being zoomed into, on the notes tab. */
  nodeId: string | null;
  /** A second document open beside it (#43). Absent, not null, when there isn't one. */
  splitId?: string;
  /** A PDF open beside it (#53), and the page to show. Absent when there isn't one. */
  pdf?: { fileId: string; page?: number };
  /** On the courses tab: the course whose roadmap is open. Absent = the subject list. */
  courseId?: string;
  /** Inside a course: the unit, area of study or learning point open (its rem id). Absent = the course overview. */
  courseItem?: string;
  /** On the review tab: review only this page, or this rem and what's under and linked to it. */
  scope?: string;
}

export const HOME: Route = { tab: 'notes', nodeId: null };

const TABS: AppTab[] = ['notes', 'review', 'dictionary', 'courses'];

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
  if (head === 'courses' || head === 'review') {
    // `#/courses/<page>` — a course's roadmap; `#/review/<rem>` — a scoped session.
    const raw = rest[0];
    if (!raw) return { tab: head, nodeId: null };
    try {
      const id = decodeURIComponent(raw);
      if (head === 'review') return { tab: head, nodeId: null, scope: id };
      // `#/courses/<course>/<unit, area or point>`
      const item = rest[1] ? decodeURIComponent(rest[1]) : null;
      return { tab: head, nodeId: null, courseId: id, ...(item ? { courseItem: item } : {}) };
    } catch {
      return { tab: head, nodeId: null };
    }
  }
  if (head !== 'notes') return { tab: head, nodeId: null };

  const raw = rest[0];
  if (!raw) return { ...HOME };
  try {
    const nodeId = decodeURIComponent(raw);
    // `#/notes/<id>/split/<other>` — two documents side by side.
    if (rest[1] === 'split' && rest[2]) return { tab: 'notes', nodeId, splitId: decodeURIComponent(rest[2]) };
    // `#/notes/<id>/pdf/<file>[/<page>]` — reading a PDF beside it.
    if (rest[1] === 'pdf' && rest[2]) {
      const page = Number(rest[3]);
      return {
        tab: 'notes',
        nodeId,
        pdf: { fileId: decodeURIComponent(rest[2]), ...(Number.isInteger(page) && page > 0 ? { page } : {}) },
      };
    }
    return { tab: 'notes', nodeId };
  } catch {
    // A malformed percent-escape shouldn't be a dead end.
    return { ...HOME };
  }
}

/** The canonical hash for a route. Always absolute, always with a leading `#/`. */
export function formatRoute(route: Route): string {
  if (route.tab === 'courses' && route.courseId) {
    const course = `#/courses/${encodeURIComponent(route.courseId)}`;
    return route.courseItem ? `${course}/${encodeURIComponent(route.courseItem)}` : course;
  }
  if (route.tab === 'review' && route.scope) return `#/review/${encodeURIComponent(route.scope)}`;
  if (route.tab !== 'notes') return `#/${route.tab}`;
  if (!route.nodeId) return '#/notes';
  const main = `#/notes/${encodeURIComponent(route.nodeId)}`;
  if (route.pdf) return `${main}/pdf/${encodeURIComponent(route.pdf.fileId)}${route.pdf.page ? `/${route.pdf.page}` : ''}`;
  return route.splitId ? `${main}/split/${encodeURIComponent(route.splitId)}` : main;
}

/** True when two routes point at the same place — used to avoid junk history entries. */
export function sameRoute(a: Route, b: Route): boolean {
  return (
    a.tab === b.tab &&
    a.nodeId === b.nodeId &&
    (a.splitId ?? null) === (b.splitId ?? null) &&
    (a.pdf?.fileId ?? null) === (b.pdf?.fileId ?? null) &&
    (a.pdf?.page ?? null) === (b.pdf?.page ?? null) &&
    (a.courseId ?? null) === (b.courseId ?? null) &&
    (a.courseItem ?? null) === (b.courseItem ?? null) &&
    (a.scope ?? null) === (b.scope ?? null)
  );
}
