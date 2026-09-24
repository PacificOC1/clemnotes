/**
 * A rolling record of what the app did behind your back (#62).
 *
 * A failed sync used to leave one line of text in the sidebar and nothing
 * else; an intermittent problem left no evidence at all. This keeps the last
 * few hundred events — syncs and what they moved, merges and conflicts,
 * upgrades and their snapshots, imports, image uploads, and every uncaught
 * error — in `localStorage`, so it survives the reload you do when something
 * looks wrong, and a "Copy diagnostics" button turns it into something you
 * can paste.
 *
 * Deliberately never holds note *content*: event details are counts, ids and
 * error messages, so the log is safe to share.
 */

export type DiagnosticLevel = 'info' | 'warn' | 'error';

export interface DiagnosticEvent {
  at: number;
  level: DiagnosticLevel;
  /** Where it came from: 'sync', 'upgrade', 'import', 'images', 'error', … */
  area: string;
  message: string;
  detail?: Record<string, string | number | boolean | null>;
}

const KEY = 'clemnotes:diagnostics';
export const MAX_EVENTS = 300;

let events: DiagnosticEvent[] | null = null;
const listeners = new Set<() => void>();

function load(): DiagnosticEvent[] {
  if (events) return events;
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    events = Array.isArray(parsed) ? (parsed as DiagnosticEvent[]).slice(-MAX_EVENTS) : [];
  } catch {
    events = [];
  }
  return events;
}

let saveQueued = false;
function save(): void {
  if (saveQueued) return;
  saveQueued = true;
  // Batched: a burst of events (a sync touching six tables) is one write.
  queueMicrotask(() => {
    saveQueued = false;
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(events ?? []));
    } catch {
      // Storage full or blocked: the in-memory log still works for this visit.
    }
  });
}

export function logEvent(
  area: string,
  message: string,
  detail?: DiagnosticEvent['detail'],
  level: DiagnosticLevel = 'info',
  now = Date.now()
): void {
  const list = load();
  list.push({ at: now, level, area, message, ...(detail ? { detail } : {}) });
  if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
  save();
  for (const listener of listeners) listener();
}

export function getEvents(): DiagnosticEvent[] {
  return [...load()];
}

export function clearEvents(): void {
  events = [];
  save();
  for (const listener of listeners) listener();
}

export function onEvents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function logError(area: string, error: unknown, detail?: DiagnosticEvent['detail']): void {
  logEvent(area, describe(error), detail, 'error');
}

/** The whole log as text, with enough context to be useful on its own. */
export function formatDiagnostics(extra: Record<string, string> = {}): string {
  const lines = [
    'Clemnotes diagnostics',
    `Generated: ${new Date().toISOString()}`,
    `Where: ${globalThis.location?.hash || '#/notes'}`,
    `Browser: ${globalThis.navigator?.userAgent ?? 'unknown'}`,
    `Online: ${globalThis.navigator?.onLine ?? 'unknown'}`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    '',
  ];
  for (const e of load()) {
    const detail = e.detail ? ' ' + Object.entries(e.detail).map(([k, v]) => `${k}=${v}`).join(' ') : '';
    lines.push(`${new Date(e.at).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.area}] ${e.message}${detail}`);
  }
  return lines.join('\n');
}

/** Record uncaught errors and rejected promises. Called once, at startup. */
export function captureGlobalErrors(): void {
  globalThis.addEventListener?.('error', (event) => {
    logEvent('error', (event as ErrorEvent).message || 'Uncaught error', undefined, 'error');
  });
  globalThis.addEventListener?.('unhandledrejection', (event) => {
    logError('error', (event as PromiseRejectionEvent).reason);
  });
}

/** For tests. */
export function resetDiagnosticsForTest(): void {
  events = null;
}
