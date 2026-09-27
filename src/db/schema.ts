// Core "everything is a node" data model.
// A page is just a Node with parentId === null.

import { EMPTY_DOC } from '../tiptap/docUtils';

/** Which cards a `Concept :: Descriptor` rem generates. */
export type CardDirection = 'forward' | 'both';

/**
 * The kinds of card a rem can produce.
 *
 * `list` is `Prompt >>>`: name everything underneath the rem. Its answer is
 * read from the rem's children at review time rather than stored, so adding a
 * child changes the card without touching its scheduling.
 */
export type CardKind = 'forward' | 'backward' | 'cloze' | 'list';

export interface OutlinerNode {
  id: string;
  content: string; // JSON.stringify(Tiptap doc) — the rich-text source of truth
  plainText: string; // derived plain text of `content`, kept in sync on every write; used for search/links/display titles
  parentId: string | null;
  // No `childrenIds` (#4): a rem's children are the rows whose `parentId` is it,
  // in `order`. The array used to mirror that, had to be kept in step by every
  // structural write, and could drift — now, across devices too, because sync
  // merges fields separately. Rows from older versions may still carry it; the
  // hooks in `database.ts` strip it.
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
  /**
   * Derived index keys (#16), maintained by hooks in `database.ts` — never
   * written by hand, never synced. IndexedDB can't index booleans, so "is a
   * live page" and "makes cards" are mirrored as a string present only when
   * true, which an index *can* find: `'page'` / `'card'`, or absent.
   */
  rootKey?: 'page';
  cardKey?: 'card';
  /**
   * The rem's text, trimmed and lowercased, when it is short enough to be a
   * title (#15). What a hand-typed `[[link]]` is matched against — an index
   * lookup instead of reading every rem.
   */
  titleKey?: string;
  /**
   * The PDFs this rem holds (a PDF block) or quotes (a highlight's page chip)
   * — derived from `content`, indexed, local-only (#53).
   */
  pdfKeys?: string[];
}

/** Fields that exist only in this browser and must be stripped before a row leaves it. */
export const LOCAL_ONLY_NODE_FIELDS = ['rootKey', 'cardKey', 'titleKey', 'pdfKeys'] as const;

/**
 * Fields older versions wrote that nothing reads any more. Stripped on the way
 * into the database and on the way out to sync, so they fade away rather than
 * travelling forever.
 */
export const LEGACY_NODE_FIELDS = ['childrenIds'] as const;

/** Longest text still treated as a possible title for link matching. */
export const TITLE_KEY_MAX = 200;

/** How a title is compared: trimmed, case-insensitive. */
export function titleKeyOf(text: string): string {
  return text.trim().toLowerCase();
}

/** The derived keys a node should carry. */
export function derivedNodeKeys(
  node: Pick<OutlinerNode, 'isPage' | 'parentId' | 'deletedAt' | 'isCard'> & { plainText?: string; content?: string }
): {
  rootKey: 'page' | undefined;
  cardKey: 'card' | undefined;
  titleKey: string | undefined;
  pdfKeys: string[];
} {
  const live = !node.deletedAt;
  const title = titleKeyOf(node.plainText ?? '');
  return {
    rootKey: live && node.isPage && node.parentId === null ? 'page' : undefined,
    cardKey: live && node.isCard ? 'card' : undefined,
    titleKey: live && title && title.length <= TITLE_KEY_MAX ? title : undefined,
    pdfKeys: live ? pdfIdsIn(node.content ?? '') : [],
  };
}

/**
 * The PDF ids a stored doc refers to, through a PDF block (`remPdf`) or a
 * highlight's page chip (`pdfAnchor`). Cheap for the common case: a doc that
 * mentions neither is never parsed.
 */
export function pdfIdsIn(content: string): string[] {
  if (!content.includes('"remPdf"') && !content.includes('"pdfAnchor"')) return [];
  const ids = new Set<string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; attrs?: { fileId?: unknown }; content?: unknown[] };
    if ((n.type === 'remPdf' || n.type === 'pdfAnchor') && typeof n.attrs?.fileId === 'string') ids.add(n.attrs.fileId);
    n.content?.forEach(walk);
  };
  try {
    walk(JSON.parse(content));
  } catch {
    return [];
  }
  return [...ids];
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
  intervalDays: number; // days until next review after the last successful one
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

/**
 * An image pasted or dropped into a rem.
 *
 * The rem's doc holds only `imageId`; the bytes live here, so a notebook full
 * of screenshots still renders offline and the doc stays small enough to sync
 * row by row. Stored as an `ArrayBuffer` rather than a `Blob` because every
 * IndexedDB implementation — and the one the tests run on — clones those
 * without surprises.
 *
 * Deliberately **not** a synced table: the bytes travel through Supabase
 * Storage instead (see `src/sync/imageSync.ts`), and `uploadedAt` is this
 * device's record of whether it has sent them yet, so it is local by nature.
 */
export interface StoredImage {
  id: string;
  mime: string;
  data: ArrayBuffer;
  width: number | null;
  height: number | null;
  /** Bytes, for the backup panel and for deciding whether to shrink it. */
  size: number;
  /**
   * When the bytes were last known to be in cloud storage; 0 = not yet. Not
   * null, so the "still to upload" rows can be found through an index.
   */
  uploadedAt: number;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Why a version was kept.
 *
 * - `edit` — the text as it was before you started editing it again after a
 *   pause (one per burst of typing, not one per keystroke).
 * - `restore` — the text as it was just before you restored an older version.
 * - `conflict` — the side that lost when this rem was edited on two devices
 *   between syncs. Nothing else in the app would otherwise remember it.
 */
export type VersionReason = 'edit' | 'restore' | 'conflict';

/**
 * A past state of one rem's text. Local to this device, like the undo stack:
 * version history is a safety net for this browser's copy, and syncing every
 * version of every rem would multiply the sync payload for little gain.
 */
export interface RemVersion {
  id: string;
  nodeId: string;
  content: string;
  plainText: string;
  savedAt: number;
  reason: VersionReason;
  /** For `conflict`: which side's text this is. */
  from?: 'this device' | 'another device';
  /** For `conflict`: false until someone has looked at it. */
  seen?: boolean;
}

/**
 * The last copy of a rem that this device and the cloud agreed on — the
 * common ancestor a three-way merge needs (#22). Local only; one per rem.
 */
export interface SyncBase {
  id: string;
  row: OutlinerNode;
}
