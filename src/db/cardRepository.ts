import { db } from './database';
import { buildPageIndex, countByPage, scopeCards } from './cardScope';
import { buildReviewEntry, getTodayCounts } from './reviewRepository';
import { DEFAULT_EASE, schedule } from '../srs/sm2';
import { isLeech, planPractice, planSession, type SessionPlan } from '../srs/session';
import { loadSettings, type ReviewSettings } from '../srs/settings';
import { extractClozeIndices, parseDoc, splitOnSeparator } from '../tiptap/docUtils';
import type { CardKind, Flashcard, OutlinerNode } from './schema';

interface DesiredCard {
  id: string;
  kind: CardKind;
  clozeIndex: number | null;
}

/** The set of cards a rem's current content should produce. */
function desiredCards(node: OutlinerNode): DesiredCard[] {
  if (node.isPortal || node.deletedAt) return [];

  const doc = parseDoc(node.content);
  const clozes = extractClozeIndices(doc);

  // Cloze wins over `::` — a rem with blanks in it is a cloze rem, even if the
  // sentence happens to contain a colon pair somewhere.
  if (clozes.length > 0) {
    return clozes.map((index) => ({
      id: `${node.id}::cloze:${index}`,
      kind: 'cloze' as const,
      clozeIndex: index,
    }));
  }

  if (!splitOnSeparator(doc)) return [];

  const cards: DesiredCard[] = [{ id: `${node.id}::forward`, kind: 'forward', clozeIndex: null }];
  if (node.cardDirection === 'both') {
    cards.push({ id: `${node.id}::backward`, kind: 'backward', clozeIndex: null });
  }
  return cards;
}

function newCard(nodeId: string, desired: DesiredCard, now: number): Flashcard {
  return {
    id: desired.id,
    nodeId,
    kind: desired.kind,
    clozeIndex: desired.clozeIndex,
    easeFactor: DEFAULT_EASE,
    interval: 0,
    repetitions: 0,
    lapses: 0,
    dueAt: now, // brand new cards are due immediately
    lastReviewedAt: null,
    suspended: false,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Bring a rem's cards in line with its content. Called after every content
 * edit, so it has to be cheap and idempotent: card IDs are derived from the
 * rem's ID and the card's role, so re-running this never duplicates anything,
 * and a card that disappears and comes back (you delete a `::` then undo)
 * keeps the scheduling history it had before.
 */
export async function reconcileCards(node: OutlinerNode): Promise<void> {
  const desired = desiredCards(node);
  const existing = await db.cards.where('nodeId').equals(node.id).toArray();
  const now = Date.now();

  const desiredById = new Map(desired.map((d) => [d.id, d]));
  const existingById = new Map(existing.map((c) => [c.id, c]));

  const toPut: Flashcard[] = [];

  for (const want of desired) {
    const have = existingById.get(want.id);
    if (!have) {
      toPut.push(newCard(node.id, want, now));
    } else if (have.deletedAt !== null) {
      // Resurrect with its old scheduling intact.
      toPut.push({ ...have, deletedAt: null, updatedAt: now });
    }
  }

  for (const have of existing) {
    if (!desiredById.has(have.id) && have.deletedAt === null) {
      toPut.push({ ...have, deletedAt: now, updatedAt: now });
    }
  }

  if (toPut.length > 0) await db.cards.bulkPut(toPut);

  const isCard = desired.length > 0;
  if (node.isCard !== isCard) {
    await db.nodes.update(node.id, { isCard, updatedAt: now });
  }
}

/** Soft-delete every card belonging to a rem — used when the rem itself is deleted. */
export async function deleteCardsForNode(nodeId: string): Promise<void> {
  const cards = await db.cards.where('nodeId').equals(nodeId).toArray();
  const now = Date.now();
  const live = cards.filter((c) => c.deletedAt === null);
  if (live.length === 0) return;
  await db.cards.bulkPut(live.map((c) => ({ ...c, deletedAt: now, updatedAt: now })));
}

export async function getCardsForNode(nodeId: string): Promise<Flashcard[]> {
  const cards = await db.cards.where('nodeId').equals(nodeId).toArray();
  return cards.filter((c) => c.deletedAt === null);
}

export async function getAllCards(): Promise<Flashcard[]> {
  const cards = await db.cards.toArray();
  return cards.filter((c) => c.deletedAt === null);
}

/**
 * The review queue: everything due now, oldest-due first so the most overdue
 * cards come back before ones that only just tipped over.
 */
export async function getDueCards(now = Date.now()): Promise<Flashcard[]> {
  const cards = await getAllCards();
  return cards
    .filter((card) => !card.suspended && card.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt);
}

/**
 * Narrow a set of cards to one document, when a scope is given.
 *
 * Costs one read of the nodes table, and only when a scope is actually in
 * play — see `cardScope.ts` for why the page is resolved rather than stored.
 */
async function applyScope(cards: Flashcard[], pageId: string | null): Promise<Flashcard[]> {
  if (!pageId) return cards;
  return scopeCards(cards, buildPageIndex(await db.nodes.toArray()), pageId);
}

/**
 * The queue for a review session: everything due, minus what the daily limits
 * and sibling burying hold back, and optionally only from one document.
 *
 * Built once when the session starts rather than consulted per card, so the
 * count you are shown at the top is the number of cards you will actually be
 * asked — and so changing a limit mid-session cannot move the finish line
 * while you are walking towards it.
 */
export async function buildReviewQueue(
  settings: ReviewSettings = loadSettings(),
  now = Date.now(),
  pageId: string | null = null
): Promise<SessionPlan> {
  const [due, today] = await Promise.all([getDueCards(now), getTodayCounts(now)]);
  return planSession(await applyScope(due, pageId), settings, today);
}

/**
 * A practice queue. Nothing that happens in a practice session is written
 * anywhere, so this can draw on the whole collection rather than only what is
 * due — which is the point of it: the night before an exam you want the
 * material you are worried about, not the material the scheduler happens to
 * have queued. Scoping it to that exam's document is the other half of that.
 */
export async function buildPracticeQueue(
  limit = 40,
  pageId: string | null = null
): Promise<Flashcard[]> {
  return planPractice(await applyScope(await getAllCards(), pageId), limit);
}

export interface PageCardCount {
  pageId: string;
  title: string;
  due: number;
  total: number;
}

/**
 * Due and total counts per document, for the scope picker.
 *
 * One nodes read and one cards read, shared between both counts. Pages with no
 * cards at all are left out — a scope picker listing every page you have ever
 * made, most of them empty, is a worse tool than one listing the four you
 * actually study.
 */
export async function getPageCardCounts(now = Date.now()): Promise<PageCardCount[]> {
  const [nodes, cards] = await Promise.all([db.nodes.toArray(), getAllCards()]);
  const pageIndex = buildPageIndex(nodes);

  const totals = countByPage(cards, pageIndex);
  const dues = countByPage(
    cards.filter((card) => !card.suspended && card.dueAt <= now),
    pageIndex
  );

  const titles = new Map(nodes.map((node) => [node.id, node.plainText.trim() || 'Untitled']));

  return [...totals.entries()]
    .map(([pageId, total]) => ({
      pageId,
      title: titles.get(pageId) ?? 'Untitled',
      due: dues.get(pageId) ?? 0,
      total,
    }))
    .sort((a, b) => b.due - a.due || a.title.localeCompare(b.title));
}

/**
 * Cards you keep failing.
 *
 * A card failed eight times is nearly always a badly written card rather than
 * a fact you are incapable of learning — two ideas crammed into one blank, or
 * an answer that could equally be three other things. Surfacing them is worth
 * more than any amount of rescheduling, because the fix is to rewrite the rem.
 */
export async function getLeeches(threshold: number | null): Promise<Flashcard[]> {
  if (threshold === null) return [];
  const cards = await getAllCards();
  return cards
    .filter((card) => isLeech(card, threshold))
    .sort((a, b) => b.lapses - a.lapses || a.dueAt - b.dueAt);
}

export interface CardStats {
  total: number;
  due: number;
  fresh: number; // never reviewed
  learning: number; // seen, but not yet on a multi-day interval
  mature: number; // interval of three weeks or more
}

export async function getCardStats(now = Date.now()): Promise<CardStats> {
  const cards = await getAllCards();
  return {
    total: cards.length,
    due: cards.filter((c) => !c.suspended && c.dueAt <= now).length,
    fresh: cards.filter((c) => c.lastReviewedAt === null).length,
    learning: cards.filter((c) => c.lastReviewedAt !== null && c.interval < 21).length,
    mature: cards.filter((c) => c.interval >= 21).length,
  };
}

/**
 * Record a review and reschedule the card.
 *
 * The log row and the card update are written in one transaction: a review
 * that reached the log without rescheduling the card (or the reverse) would be
 * a lie about what happened, and the log is only worth having if it is exact.
 *
 * Note that the row is built from the card's state *before* `schedule()` is
 * applied — that pre-review state is the part that gets overwritten, and it is
 * what any later analysis actually needs.
 */
export async function gradeCard(cardId: string, quality: number): Promise<void> {
  const card = await db.cards.get(cardId);
  if (!card) return;
  const now = Date.now();
  const update = schedule(card, quality, now);
  const entry = buildReviewEntry(card, quality, update, now);

  await db.transaction('rw', db.cards, db.reviews, async () => {
    await db.cards.update(cardId, { ...update, updatedAt: now });
    await db.reviews.add(entry);
  });
}

export async function setCardSuspended(cardId: string, suspended: boolean): Promise<void> {
  await db.cards.update(cardId, { suspended, updatedAt: Date.now() });
}

/**
 * Reset a card's scheduling back to "never seen".
 *
 * This does not touch the review log — those reviews still happened, and the
 * log is append-only. Statistics will show the card's full history while its
 * schedule starts again from zero, which is the honest reading of a reset.
 */
export async function resetCard(cardId: string): Promise<void> {
  const now = Date.now();
  await db.cards.update(cardId, {
    easeFactor: DEFAULT_EASE,
    interval: 0,
    repetitions: 0,
    lapses: 0,
    dueAt: now,
    lastReviewedAt: null,
    updatedAt: now,
  });
}

/** Flip a `A :: B` rem between generating one card and generating both directions. */
export async function toggleCardDirection(nodeId: string): Promise<void> {
  const node = await db.nodes.get(nodeId);
  if (!node) return;
  const cardDirection = node.cardDirection === 'both' ? 'forward' : 'both';
  await db.nodes.update(nodeId, { cardDirection, updatedAt: Date.now() });
  await reconcileCards({ ...node, cardDirection });
}
