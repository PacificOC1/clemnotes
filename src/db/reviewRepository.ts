import { v4 as uuid } from 'uuid';
import { db } from './database';
import type { Flashcard, ReviewLogEntry, ReviewState } from './schema';
import type { ScheduleUpdate } from '../srs/sm2';
import type { TodayCounts } from '../srs/session';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The review log — an append-only record of every grade you have given.
 *
 * Writes go through `buildReviewEntry` at the one place a card is graded;
 * everything else here is a read. Nothing in this module updates or deletes a
 * row, and nothing should: the value of the table is that it is the one part
 * of the flashcard system that never loses information.
 */

/**
 * Which phase of its life a card was in when it was shown.
 *
 * SM-2 doesn't track this explicitly, so it is derived from the state the card
 * carried into the review — and it has to be derived *then*, because once the
 * card is rescheduled the distinction between "first ever sight of this card"
 * and "a card that lapsed yesterday" is no longer visible in its fields.
 */
export function reviewStateOf(card: Flashcard): ReviewState {
  if (card.lastReviewedAt === null) return 'new';
  if (card.lapses > 0 && card.repetitions === 0) return 'relearning';
  if (card.repetitions === 0) return 'learning';
  // Below the six-day interval a card is still working its way up the
  // graduating steps rather than genuinely in long-term review.
  return card.interval >= 6 ? 'review' : 'learning';
}

/**
 * Turn one grading into a log row. Pure — the caller persists it, so the row
 * and the card update can go into a single transaction and a crash can't
 * leave a review recorded against a card that was never rescheduled.
 */
export function buildReviewEntry(
  card: Flashcard,
  quality: number,
  next: ScheduleUpdate,
  now: number
): ReviewLogEntry {
  return {
    id: uuid(),
    cardId: card.id,
    nodeId: card.nodeId,
    kind: card.kind,
    grade: quality,
    reviewedAt: now,
    scheduledFor: card.dueAt,
    elapsedMs: card.lastReviewedAt === null ? null : now - card.lastReviewedAt,
    state: reviewStateOf(card),
    intervalBefore: card.interval,
    intervalAfter: next.interval,
    easeBefore: card.easeFactor,
    easeAfter: next.easeFactor,
    repetitionsBefore: card.repetitions,
    lapsesBefore: card.lapses,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getAllReviews(): Promise<ReviewLogEntry[]> {
  const rows = await db.reviews.toArray();
  return rows.filter((r) => r.deletedAt === null);
}

/** One card's full history, oldest first. */
export async function getReviewsForCard(cardId: string): Promise<ReviewLogEntry[]> {
  const rows = await db.reviews.where('cardId').equals(cardId).toArray();
  return rows.filter((r) => r.deletedAt === null).sort((a, b) => a.reviewedAt - b.reviewedAt);
}

/** Everything reviewed in a window, oldest first. Indexed, so it stays cheap as the log grows. */
export async function getReviewsBetween(from: number, to = Date.now()): Promise<ReviewLogEntry[]> {
  const rows = await db.reviews.where('reviewedAt').between(from, to, true, true).toArray();
  return rows.filter((r) => r.deletedAt === null).sort((a, b) => a.reviewedAt - b.reviewedAt);
}

export interface ReviewSummary {
  reviews: number;
  /** Reviews graded 3 or better, as a fraction of reviews of cards that weren't new. */
  retention: number | null;
  lapses: number;
  /** Distinct cards seen. */
  cards: number;
  /** Reviews per day, keyed `YYYY-MM-DD` in local time. */
  perDay: Map<string, number>;
}

/** Local-time `YYYY-MM-DD`. Local rather than UTC because a day of reviewing is
 *  a day in the life of the person doing it, not a UTC window. */
export function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Roll a window of the log up into the numbers a stats view would want.
 *
 * Retention deliberately excludes cards being seen for the first time: a new
 * card you have never studied is not a memory you failed to retain, and
 * counting it drags the figure down in a way that says nothing about how well
 * your reviewing is working.
 */
export function summarizeReviews(rows: ReviewLogEntry[]): ReviewSummary {
  const perDay = new Map<string, number>();
  const cards = new Set<string>();
  let lapses = 0;
  let retentionEligible = 0;
  let retentionPassed = 0;

  for (const row of rows) {
    cards.add(row.cardId);
    perDay.set(dayKey(row.reviewedAt), (perDay.get(dayKey(row.reviewedAt)) ?? 0) + 1);
    if (row.grade < 3) lapses += 1;
    if (row.state !== 'new') {
      retentionEligible += 1;
      if (row.grade >= 3) retentionPassed += 1;
    }
  }

  return {
    reviews: rows.length,
    retention: retentionEligible === 0 ? null : retentionPassed / retentionEligible,
    lapses,
    cards: cards.size,
    perDay,
  };
}

/** Convenience: the last `days` days of the log, summarised. */
export async function getRecentReviewSummary(days = 30, now = Date.now()): Promise<ReviewSummary> {
  return summarizeReviews(await getReviewsBetween(now - days * DAY_MS, now));
}

/** Split a set of log rows into first sightings and genuine reviews. */
export function countByKind(rows: ReviewLogEntry[]): TodayCounts {
  let newSeen = 0;
  for (const row of rows) if (row.state === 'new') newSeen += 1;
  return { newSeen, reviewsDone: rows.length - newSeen };
}

/**
 * What today has already contained, which is what daily limits are measured
 * against.
 *
 * The day starts at local midnight, and a card failed and shown again counts
 * twice — because it was two reviews, and a limit that quietly discounted them
 * would let a bad day run on much longer than the number you set.
 */
export async function getTodayCounts(now = Date.now()): Promise<TodayCounts> {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return countByKind(await getReviewsBetween(midnight.getTime(), now));
}
