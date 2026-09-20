import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_CURSOR, clearCursors, parseCursor, readCursor, writeCursor } from './cursors';

/**
 * A minimal `localStorage`, because the data layer runs in Node. Only the four
 * members `cursors.ts` touches, plus the indexed `key()` that `clearCursors`
 * walks.
 */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    _map: map,
  };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  storage = fakeStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});

describe('parseCursor', () => {
  it('accepts a well-formed cursor', () => {
    expect(parseCursor({ pulledThrough: 5, pushedThrough: 6, reconciledAt: 7 })).toEqual({
      pulledThrough: 5,
      pushedThrough: 6,
      reconciledAt: 7,
    });
  });

  it('reads anything unusable as empty, which forces a full reconcile', () => {
    // Losing a cursor has to be safe, so every bad value degrades the same way:
    // to "read everything", never to "skip something".
    expect(parseCursor(null)).toEqual(EMPTY_CURSOR);
    expect(parseCursor('nonsense')).toEqual(EMPTY_CURSOR);
    expect(parseCursor({ pulledThrough: 'soon' })).toEqual(EMPTY_CURSOR);
    expect(parseCursor({ pulledThrough: Number.NaN })).toEqual(EMPTY_CURSOR);
    expect(parseCursor({ pulledThrough: -1 })).toEqual(EMPTY_CURSOR);
    expect(parseCursor({ pulledThrough: Infinity })).toEqual(EMPTY_CURSOR);
  });

  it('keeps the fields it can and zeroes the ones it cannot', () => {
    expect(parseCursor({ pulledThrough: 9, reconciledAt: 'later' })).toEqual({
      pulledThrough: 9,
      pushedThrough: 0,
      reconciledAt: 0,
    });
  });
});

describe('reading and writing', () => {
  it('round-trips a cursor', () => {
    writeCursor('user-1', 'nodes', { pulledThrough: 1, pushedThrough: 2, reconciledAt: 3 });
    expect(readCursor('user-1', 'nodes')).toEqual({
      pulledThrough: 1,
      pushedThrough: 2,
      reconciledAt: 3,
    });
  });

  it('keeps tables and users apart', () => {
    writeCursor('user-1', 'nodes', { pulledThrough: 1, pushedThrough: 1, reconciledAt: 1 });
    expect(readCursor('user-1', 'cards')).toEqual(EMPTY_CURSOR);
    // Signing in as someone else must never reuse a position read from another
    // account's data.
    expect(readCursor('user-2', 'nodes')).toEqual(EMPTY_CURSOR);
  });

  it('reads an empty cursor for a table it has never seen', () => {
    expect(readCursor('user-1', 'nodes')).toEqual(EMPTY_CURSOR);
  });

  it('survives corrupt stored JSON', () => {
    storage.setItem('clemnotes.sync.user-1.nodes', '{not json');
    expect(readCursor('user-1', 'nodes')).toEqual(EMPTY_CURSOR);
  });
});

describe('clearCursors', () => {
  beforeEach(() => {
    writeCursor('user-1', 'nodes', { pulledThrough: 1, pushedThrough: 1, reconciledAt: 1 });
    writeCursor('user-1', 'cards', { pulledThrough: 2, pushedThrough: 2, reconciledAt: 2 });
    writeCursor('user-2', 'nodes', { pulledThrough: 3, pushedThrough: 3, reconciledAt: 3 });
    storage.setItem('clemnotes.reviewSettings', '{"newPerDay":20}');
  });

  it('clears one user without touching another', () => {
    clearCursors('user-1');
    expect(readCursor('user-1', 'nodes')).toEqual(EMPTY_CURSOR);
    expect(readCursor('user-1', 'cards')).toEqual(EMPTY_CURSOR);
    expect(readCursor('user-2', 'nodes').pulledThrough).toBe(3);
  });

  it('clears every user when given none', () => {
    clearCursors();
    expect(readCursor('user-2', 'nodes')).toEqual(EMPTY_CURSOR);
  });

  it('leaves unrelated settings alone', () => {
    clearCursors();
    expect(storage.getItem('clemnotes.reviewSettings')).toBe('{"newPerDay":20}');
  });
});

describe('without storage', () => {
  it('falls back to a full reconcile rather than failing', () => {
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    expect(readCursor('user-1', 'nodes')).toEqual(EMPTY_CURSOR);
    expect(() => writeCursor('user-1', 'nodes', EMPTY_CURSOR)).not.toThrow();
    expect(() => clearCursors()).not.toThrow();
  });
});
