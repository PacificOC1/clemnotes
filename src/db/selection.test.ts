import { describe, expect, it } from 'vitest';
import { applyRowClick, inDisplayOrder, normalizeSelection, rangeBetween } from './selection';

/** page → a → a1 → a1i, b, c */
const PARENTS: Record<string, string | null> = {
  page: null,
  a: 'page',
  a1: 'a',
  a1i: 'a1',
  b: 'page',
  c: 'page',
};
const parentOf = (id: string) => PARENTS[id] ?? null;
const ORDER = ['a', 'a1', 'a1i', 'b', 'c'];

describe('normalizeSelection', () => {
  it('drops a rem whose ancestor is also selected', () => {
    // Indenting a parent already carries its children; indenting both moves
    // the child twice, the second time relative to a tree that has changed.
    expect(normalizeSelection(['a', 'a1'], parentOf).sort()).toEqual(['a']);
    expect(normalizeSelection(['a', 'a1i'], parentOf).sort()).toEqual(['a']);
    expect(normalizeSelection(['a', 'a1', 'a1i'], parentOf).sort()).toEqual(['a']);
  });

  it('keeps siblings, and keeps cousins', () => {
    expect(normalizeSelection(['a', 'b', 'c'], parentOf).sort()).toEqual(['a', 'b', 'c']);
    expect(normalizeSelection(['a1', 'b'], parentOf).sort()).toEqual(['a1', 'b']);
  });

  it('keeps a descendant when the ancestor is not selected', () => {
    expect(normalizeSelection(['a1i'], parentOf)).toEqual(['a1i']);
  });

  it('de-duplicates', () => {
    expect(normalizeSelection(['b', 'b', 'b'], parentOf)).toEqual(['b']);
  });

  it('handles an empty selection', () => {
    expect(normalizeSelection([], parentOf)).toEqual([]);
  });

  it('does not spin on a corrupt parent cycle', () => {
    // In a cycle every member is an ancestor of every other, so all of them
    // are dropped and the operation does nothing. For data that should not
    // exist, doing nothing beats doing something arbitrary — and the point of
    // the guard is that it terminates at all.
    const cyclic = (id: string) => (id === 'x' ? 'y' : id === 'y' ? 'x' : null);
    expect(normalizeSelection(['x', 'y'], cyclic)).toEqual([]);
  });

  it('keeps a rem whose ancestor chain cycles above it', () => {
    const cyclic = (id: string) => (id === 'leaf' ? 'x' : id === 'x' ? 'y' : 'x');
    expect(normalizeSelection(['leaf'], cyclic)).toEqual(['leaf']);
  });

  it('copes with a parent that is not in the tree any more', () => {
    expect(normalizeSelection(['orphan'], () => 'gone')).toEqual(['orphan']);
  });
});

describe('inDisplayOrder', () => {
  it('sorts by where things appear on screen', () => {
    expect(inDisplayOrder(['c', 'a', 'b'], ORDER)).toEqual(['a', 'b', 'c']);
  });

  it('puts anything off screen at the end rather than dropping it', () => {
    expect(inDisplayOrder(['hidden', 'a'], ORDER)).toEqual(['a', 'hidden']);
  });
});

describe('rangeBetween', () => {
  it('covers everything between two rows, inclusive', () => {
    expect(rangeBetween(ORDER, 'a1', 'b')).toEqual(['a1', 'a1i', 'b']);
  });

  it('works whichever way round they were clicked', () => {
    expect(rangeBetween(ORDER, 'b', 'a1')).toEqual(['a1', 'a1i', 'b']);
  });

  it('is a single row when both ends are the same', () => {
    expect(rangeBetween(ORDER, 'b', 'b')).toEqual(['b']);
  });

  it('selects nothing when an end is off screen', () => {
    // Better than selecting something arbitrary from a row you cannot see.
    expect(rangeBetween(ORDER, 'collapsed-away', 'b')).toEqual([]);
  });
});

describe('applyRowClick', () => {
  const none: ReadonlySet<string> = new Set();

  it('toggles a row on and off', () => {
    const first = applyRowClick(none, null, 'b', ORDER, 'toggle');
    expect([...first.selected]).toEqual(['b']);
    expect(first.anchor).toBe('b');

    const second = applyRowClick(first.selected, first.anchor, 'b', ORDER, 'toggle');
    expect([...second.selected]).toEqual([]);
  });

  it('adds without disturbing what is already selected', () => {
    const first = applyRowClick(none, null, 'a', ORDER, 'toggle');
    const second = applyRowClick(first.selected, first.anchor, 'c', ORDER, 'toggle');
    expect([...second.selected].sort()).toEqual(['a', 'c']);
  });

  it('extends from the anchor', () => {
    const first = applyRowClick(none, null, 'a1', ORDER, 'toggle');
    const range = applyRowClick(first.selected, first.anchor, 'b', ORDER, 'range');
    expect([...range.selected]).toEqual(['a1', 'a1i', 'b']);
  });

  it('replaces the selection on a range, so a mis-aimed shift-click is recoverable', () => {
    const first = applyRowClick(none, null, 'a', ORDER, 'toggle');
    const tooFar = applyRowClick(first.selected, first.anchor, 'c', ORDER, 'range');
    expect([...tooFar.selected]).toEqual(['a', 'a1', 'a1i', 'b', 'c']);
    const corrected = applyRowClick(tooFar.selected, tooFar.anchor, 'a1', ORDER, 'range');
    expect([...corrected.selected]).toEqual(['a', 'a1']);
  });

  it('keeps the anchor where it was across a range', () => {
    const first = applyRowClick(none, null, 'a', ORDER, 'toggle');
    const range = applyRowClick(first.selected, first.anchor, 'c', ORDER, 'range');
    expect(range.anchor).toBe('a');
  });

  it('falls back to a toggle when there is no anchor yet', () => {
    const range = applyRowClick(none, null, 'b', ORDER, 'range');
    expect([...range.selected]).toEqual(['b']);
  });
});
