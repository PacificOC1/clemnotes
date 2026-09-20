import type { Flashcard, OutlinerNode } from './schema';

/**
 * Which document a card belongs to.
 *
 * The queue is otherwise global, which is fine until you are carrying cards
 * from six subjects and have an exam in one of them tomorrow. A card knows its
 * rem; a rem knows its parent; the document is whatever sits at the top of
 * that chain.
 *
 * Deliberately *not* stored on the card. Storing it would save a lookup, but
 * it would also mean a new column on `cards` — and therefore a Supabase
 * migration that has to be run before flashcards will sync at all. Resolving
 * it instead costs one read of the nodes table, once, when a scoped session is
 * built: the walk is memoised across every card, so a thousand cards cost a
 * thousand map lookups rather than a thousand tree walks. An unscoped session,
 * which is the common case, pays nothing.
 *
 * The other reason not to store it: a rem can be dragged to a different page,
 * and a stored page id would silently go stale the moment that happened.
 */

/**
 * Map every rem to the id of the document it sits in.
 *
 * Built in one pass with memoisation, so a deep tree is walked once rather
 * than once per leaf. A rem whose parent chain is broken — a parent that was
 * hard-deleted, or a row that arrived from sync before its ancestors — maps to
 * itself, which keeps it reachable in *some* scope rather than invisible.
 */
export function buildPageIndex(nodes: OutlinerNode[]): Map<string, string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rootOf = new Map<string, string>();

  function resolve(id: string): string {
    const cached = rootOf.get(id);
    if (cached) return cached;

    // Iterative, and guarded: a corrupt parent cycle must not hang the app.
    const chain: string[] = [];
    const seen = new Set<string>();
    let current = id;
    let root = id;

    for (;;) {
      if (seen.has(current)) {
        root = current;
        break;
      }
      seen.add(current);

      const known = rootOf.get(current);
      if (known) {
        root = known;
        break;
      }

      chain.push(current);
      const node = byId.get(current);
      if (!node || !node.parentId || !byId.has(node.parentId)) {
        root = current;
        break;
      }
      current = node.parentId;
    }

    for (const step of chain) rootOf.set(step, root);
    return root;
  }

  for (const node of nodes) resolve(node.id);
  return rootOf;
}

/** The document each card belongs to, as `cardId → pageId`. */
export function mapCardsToPages(
  cards: Flashcard[],
  pageIndex: Map<string, string>
): Map<string, string> {
  const out = new Map<string, string>();
  for (const card of cards) {
    const page = pageIndex.get(card.nodeId);
    if (page) out.set(card.id, page);
  }
  return out;
}

/** Keep only the cards belonging to `pageId`. A null scope keeps everything. */
export function scopeCards(
  cards: Flashcard[],
  pageIndex: Map<string, string>,
  pageId: string | null
): Flashcard[] {
  if (!pageId) return cards;
  return cards.filter((card) => pageIndex.get(card.nodeId) === pageId);
}

/** How many of these cards each document accounts for. */
export function countByPage(
  cards: Flashcard[],
  pageIndex: Map<string, string>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const card of cards) {
    const page = pageIndex.get(card.nodeId);
    if (!page) continue;
    counts.set(page, (counts.get(page) ?? 0) + 1);
  }
  return counts;
}
