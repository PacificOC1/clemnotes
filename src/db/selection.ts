/**
 * Working on more than one rem at a time.
 *
 * Every structural operation the app has — indent, outdent, move, delete —
 * acts on a single rem, which is where an outliner most wants to be fast.
 * Extending them to a set is mostly bookkeeping, except for one rule that is
 * easy to get wrong and impossible to notice afterwards:
 *
 * **A selection that contains both a rem and something inside it must be
 * reduced to the outer rem before anything is applied.** Indenting a parent
 * already carries its children; indenting both moves the child twice, and the
 * second move is relative to a tree that has already changed under it. Deleting
 * both is harmless but does twice the writes. Normalising first makes the whole
 * class of bug unrepresentable.
 */

/** The ids in `selected` that have no ancestor also in `selected`. */
export function normalizeSelection(
  selected: Iterable<string>,
  parentOf: (id: string) => string | null | undefined
): string[] {
  const set = new Set(selected);

  function hasSelectedAncestor(id: string): boolean {
    const seen = new Set<string>([id]);
    let current = parentOf(id);
    while (current) {
      // A corrupt parent cycle must not spin here.
      if (seen.has(current)) return false;
      if (set.has(current)) return true;
      seen.add(current);
      current = parentOf(current);
    }
    return false;
  }

  return [...set].filter((id) => !hasSelectedAncestor(id));
}

/**
 * Put ids into the order they appear on screen.
 *
 * Direction matters for the operations themselves: indenting a run of siblings
 * has to go top-down, because each one is indented under the sibling above it
 * and that sibling must not have moved yet. Outdenting has to go bottom-up for
 * the mirror-image reason.
 */
export function inDisplayOrder(ids: Iterable<string>, order: string[]): string[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...ids].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
}

/**
 * Everything between two rows on screen, inclusive, whichever way round they
 * were clicked. Ids not on screen are simply absent from `order`, so a range
 * anchored on one of them selects nothing rather than something arbitrary.
 */
export function rangeBetween(order: string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a === -1 || b === -1) return [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Shift-click extends from the anchor; plain toggle adds or removes one row. */
export function applyRowClick(
  current: ReadonlySet<string>,
  anchor: string | null,
  clicked: string,
  order: string[],
  mode: 'toggle' | 'range'
): { selected: Set<string>; anchor: string } {
  if (mode === 'range' && anchor) {
    // A range replaces the selection rather than adding to it, which is what
    // makes a mis-aimed shift-click recoverable with another shift-click.
    return { selected: new Set(rangeBetween(order, anchor, clicked)), anchor };
  }

  const selected = new Set(current);
  if (selected.has(clicked)) selected.delete(clicked);
  else selected.add(clicked);
  return { selected, anchor: clicked };
}
