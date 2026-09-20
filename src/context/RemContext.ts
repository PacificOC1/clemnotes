import { createContext, useContext } from 'react';

/**
 * Which rem the surrounding editor belongs to.
 *
 * Tiptap node views are rendered through React portals that stay inside the
 * parent tree, so context reaches them — which is how `WikiLinkNode` already
 * gets navigation. A block like the query list needs to know where it is
 * sitting in order to scope itself to "this document", and the editor itself
 * has no idea: it only knows its own doc.
 */
export const RemContext = createContext<{ nodeId: string | null }>({ nodeId: null });

export function useRemId(): string | null {
  return useContext(RemContext).nodeId;
}
