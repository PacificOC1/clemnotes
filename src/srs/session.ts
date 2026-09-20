import type { Flashcard } from '../db/schema';
import type { ReviewSettings } from './settings';

/**
 * Turning "everything that is due" into "what you are going to do now".
 *
 * Pure, and separate from the database read, because the interesting part is
 * the policy: which cards a daily limit holds back, and which ones showing
 * would give away another card's answer. Both are easy to get subtly wrong and
 * neither needs IndexedDB to exercise.
 */

/** What has already been done today, read from the review log. */
export interface TodayCounts {
  /** Reviews of cards that were being seen for the first time. */
  newSeen: number;
  /** Reviews of cards that had been seen before. */
  reviewsDone: number;
}

export interface SessionPlan {
  queue: Flashcard[];
  /** Cards in the queue being seen for the first time. */
  newCount: number;
  /** Cards in the queue that have been seen before. */
  reviewCount: number;
  /** Due cards left out because the daily limit was reached. */
  heldByLimit: number;
  /** Due cards left out because a sibling of theirs is already in the queue. */
  heldBySiblings: number;
}

const EMPTY_TODAY: TodayCounts = { newSeen: 0, reviewsDone: 0 };

/** True once a card has failed often enough to be worth rewriting rather than re-reviewing. */
export function isLeech(card: Flashcard, threshold: number | null): boolean {
  return threshold !== null && card.lapses >= threshold;
}

/**
 * Build the session queue from the cards that are due.
 *
 * `due` is expected in the order the queue should prefer — most overdue first,
 * as `getDueCards` returns it — and that order is preserved. New and seen
 * cards draw on separate allowances, so a backlog of reviews can't starve you
 * of new material and a pile of new cards can't crowd out the reviews that
 * keep what you already know alive.
 */
export function planSession(
  due: Flashcard[],
  settings: ReviewSettings,
  today: TodayCounts = EMPTY_TODAY
): SessionPlan {
  const newAllowance =
    settings.newPerDay === null ? Infinity : Math.max(0, settings.newPerDay - today.newSeen);
  const reviewAllowance =
    settings.reviewsPerDay === null
      ? Infinity
      : Math.max(0, settings.reviewsPerDay - today.reviewsDone);

  const queue: Flashcard[] = [];
  const remsInQueue = new Set<string>();
  let newCount = 0;
  let reviewCount = 0;
  let heldByLimit = 0;
  let heldBySiblings = 0;

  for (const card of due) {
    // A sentence with three blanks makes three cards. Answering the first
    // hands you the context for the other two, so you score them as remembered
    // when you have really just read them — hold them for another day.
    if (settings.burySiblings && remsInQueue.has(card.nodeId)) {
      heldBySiblings += 1;
      continue;
    }

    const isNew = card.lastReviewedAt === null;
    if (isNew ? newCount >= newAllowance : reviewCount >= reviewAllowance) {
      heldByLimit += 1;
      continue;
    }

    queue.push(card);
    remsInQueue.add(card.nodeId);
    if (isNew) newCount += 1;
    else reviewCount += 1;
  }

  return { queue, newCount, reviewCount, heldByLimit, heldBySiblings };
}

/**
 * A practice queue: cards to drill without touching anything.
 *
 * Deliberately not the due queue. Drilling before an exam is about the
 * material you are worried about, which is mostly *not* what happens to be due
 * tonight — so this draws on everything unsuspended, shuffled, and the caller
 * grades nothing.
 */
export function planPractice(cards: Flashcard[], limit = 40, random = Math.random): Flashcard[] {
  const pool = cards.filter((card) => !card.suspended);
  // Fisher-Yates on a copy.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, limit);
}
