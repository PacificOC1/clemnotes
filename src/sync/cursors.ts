/**
 * Where each table's sync got to last time.
 *
 * A cursor is per device and per user, never synced: it describes what *this*
 * browser has already seen, which is meaningless on any other device. Losing
 * it is safe — an empty cursor means "reconcile everything", which is exactly
 * the right recovery — so `localStorage` is the honest home for it rather than
 * a table that would then need its own merge rule.
 */

export interface SyncCursor {
  /** Remote rows with `updatedAt` at or below this have already been pulled. */
  pulledThrough: number;
  /** Local rows with `updatedAt` below this have already been pushed. */
  pushedThrough: number;
  /** When this table last did a full reconcile; 0 means never. */
  reconciledAt: number;
}

export const EMPTY_CURSOR: SyncCursor = { pulledThrough: 0, pushedThrough: 0, reconciledAt: 0 };

const PREFIX = 'clemnotes.sync';

function key(userId: string, table: string): string {
  return `${PREFIX}.${userId}.${table}`;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Anything unparseable reads as an empty cursor, which forces a full reconcile. */
export function parseCursor(raw: unknown): SyncCursor {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_CURSOR };
  const input = raw as Partial<SyncCursor>;
  return {
    pulledThrough: isTimestamp(input.pulledThrough) ? input.pulledThrough : 0,
    pushedThrough: isTimestamp(input.pushedThrough) ? input.pushedThrough : 0,
    reconciledAt: isTimestamp(input.reconciledAt) ? input.reconciledAt : 0,
  };
}

export function readCursor(userId: string, table: string): SyncCursor {
  try {
    const raw = globalThis.localStorage?.getItem(key(userId, table));
    return raw ? parseCursor(JSON.parse(raw)) : { ...EMPTY_CURSOR };
  } catch {
    return { ...EMPTY_CURSOR };
  }
}

export function writeCursor(userId: string, table: string, cursor: SyncCursor): void {
  try {
    globalThis.localStorage?.setItem(key(userId, table), JSON.stringify(cursor));
  } catch {
    // No storage means every sync is a full reconcile. Slow, still correct.
  }
}

/** Forget where we got to, so the next sync reconciles everything from scratch. */
export function clearCursors(userId?: string): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const scope = userId ? `${PREFIX}.${userId}.` : `${PREFIX}.`;
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const name = storage.key(i);
      if (name?.startsWith(scope)) doomed.push(name);
    }
    for (const name of doomed) storage.removeItem(name);
  } catch {
    // Nothing to clear if there is no storage.
  }
}
