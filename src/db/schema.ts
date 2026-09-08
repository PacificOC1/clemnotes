// Core "everything is a node" data model.
// A page is just a Node with parentId === null.

import { EMPTY_DOC } from '../tiptap/docUtils';

/** Which cards a `Concept :: Descriptor` rem generates. */
export type CardDirection = 'forward' | 'both';

/** The three kinds of card a rem can produce. */
export type CardKind = 'forward' | 'backward' | 'cloze';

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
  isCard: boolean; // derived on write: true when this rem currently generates flashcards
  cardDirection: CardDirection; // for `A :: B` rems — forward only, or both directions
  deletedAt: number | null; // soft-delete tombstone timestamp; null = not deleted. Needed so cloud sync can propagate deletions instead of "resurrecting" them from other devices.
  createdAt: number;
  updatedAt: number;
}

/**
 * A single scheduled flashcard derived from a rem. IDs are deterministic
 * (`<nodeId>::forward`, `<nodeId>::cloze:2`, …) so that reconciling a rem's
 * cards after an edit is idempotent and safe to run on every device without
 * generating duplicates through sync.
 */
export interface Flashcard {
  id: string;
  nodeId: string;
  kind: CardKind;
  clozeIndex: number | null; // which {{cloze}} this card tests, for kind === 'cloze'
  // SM-2 state
  easeFactor: number; // 1.3 floor, 2.5 default
  interval: number; // days until next review after the last successful one
  repetitions: number; // consecutive successful reviews
  lapses: number; // times this card has been forgotten
  dueAt: number;
  lastReviewedAt: number | null;
  suspended: boolean;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DictionaryEntry {
  id: string;
  word: string; // normalized lookup key (lowercase)
  displayWord: string; // original casing for display
  definition: string;
  deletedAt: number | null; // soft-delete tombstone, so deletes propagate through cloud sync
  createdAt: number;
  updatedAt: number;
}

/** Sidebar grouping for top-level pages. */
export interface PageFolder {
  id: string;
  name: string;
  pageIds: string[];
  order: number;
  collapsed: boolean;
  deletedAt: number | null; // soft-delete tombstone, so deletes propagate through cloud sync
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
                // reordering logic lives in repository.ts
    collapsed: false,
    isPage: false,
    outboundLinks: [],
    isPortal: false,
    portalTargetId: null,
    isCard: false,
    cardDirection: 'forward',
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
