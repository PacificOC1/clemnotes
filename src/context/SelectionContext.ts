import { createContext, useContext } from 'react';

/**
 * Which rems are selected, shared with every row.
 *
 * Through context rather than props because `OutlinerNode` renders itself
 * recursively — threading a selection down by hand would mean every row
 * forwarding state it does not use, and every level re-rendering when any
 * other level's selection changed.
 */
export interface SelectionContextValue {
  selected: ReadonlySet<string>;
  /** Click on a rem's bullet with a modifier held. */
  onSelectRow: (nodeId: string, mode: 'toggle' | 'range') => void;
  clear: () => void;
}

export const SelectionContext = createContext<SelectionContextValue>({
  selected: new Set(),
  onSelectRow: () => {},
  clear: () => {},
});

export function useSelection() {
  return useContext(SelectionContext);
}
