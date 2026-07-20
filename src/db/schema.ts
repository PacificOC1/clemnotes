// Core "everything is a node" data model.
// A page is just a Node with parentId === null.

import { EMPTY_DOC } from '../tiptap/docUtils';

export interface OutlinerNode {
  id: string;
  content: string; // JSON.stringify(Tiptap doc) — the rich-text source of truth
  plainText: string; // derived plain text of `content`, kept in sync on every write; used for search/links/display titles
  parentId: string | null;
  childrenIds: string[];
  order: number; // fractional sibling order key
  collapsed: boolean;
  isPage: boolean; // true for top-level "documents" shown in the sidebar
  outboundLinks: string[]; // node IDs this node references via [[Title]] syntax
  isPortal: boolean; // true if this node is an embedded live view of another node
  portalTargetId: string | null; // the node this portal embeds, when isPortal is true
  deletedAt: number | null; // soft-delete tombstone timestamp; null = not deleted. Needed so cloud sync can propagate deletions instead of "resurrecting" them from other devices.
  createdAt: number;
  updatedAt: number;
}

export function createEmptyNode(overrides: Partial<OutlinerNode> = {}): Omit<OutlinerNode, 'id'> {
  const now = Date.now();
  return {
    content: JSON.stringify(EMPTY_DOC),
    plainText: '',
    parentId: null,
    childrenIds: [],
    order: now, // timestamp-based order is a fine default; real fractional
                // reordering logic lives in repository.ts's insertBetween()
    collapsed: false,
    isPage: false,
    outboundLinks: [],
    isPortal: false,
    portalTargetId: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
