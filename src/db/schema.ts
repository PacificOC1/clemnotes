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

/**
 * Where a card sat in its life cycle at the moment it was reviewed. Derived
 * from the card's state rather than stored on the card, because SM-2 has no
 * explicit notion of it — but every algorithm worth migrating to does, and it
 * cannot be reconstructed after the fact.
 */
export type ReviewState = 'new' | 'learning' | 'relearning' | 'review';

/**
 * One review, as it happened. Append-only: nothing ever updates a row here,
 * and nothing deletes one.
 *
 * A card records where its schedule stands *now*; this records how it got
 * there. That distinction matters because scheduling state is lossy — the
 * moment you grade a card, the fact that you graded it (when, how, how late,
 * off what interval) is gone, and no amount of later analysis can recover it.
 * Retention rates, due forecasts, leech detection and any future move to a
 * model-fitting scheduler like FSRS all read this table and none of them can
 * be backfilled from card state alone.
 *
 * `deletedAt` is here purely to satisfy the sync contract — every synced table
 * needs `updatedAt` and `deletedAt` — and stays null in practice.
 */
export interface ReviewLogEntry {
  id: string;
  cardId: string;
  nodeId: string; // denormalised so stats can group by rem without a card lookup
  kind: CardKind;
  /** SM-2 quality, 0–5, exactly as passed to `schedule()`. Below 3 is a lapse. */
  grade: number;
  reviewedAt: number;
  /** The `dueAt` the card carried going in — reviewedAt minus this is how late you were. */
  scheduledFor: number;
  /** Time since this card's previous review; null the first time it is seen. */
  elapsedMs: number | null;
  state: ReviewState;
  // Before/after pairs, so a rescheduling can be replayed or audited without
  // re-deriving it from an algorithm that may since have changed.
  intervalBefore: number;
  intervalAfter: number;
  easeBefore: number;
  easeAfter: number;
  repetitionsBefore: number;
  lapsesBefore: number;
  // Sync contract.
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
