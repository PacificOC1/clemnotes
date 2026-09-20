import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import {
  buildReviewEntry,
  getAllReviews,
  getRecentReviewSummary,
  getReviewsBetween,
  getReviewsForCard,
  reviewStateOf,
  summarizeReviews,
} from './reviewRepository';
import { schedule } from '../srs/sm2';
import { cardLike, resetDatabase } from '../test/helpers';
import type { ReviewLogEntry } from './schema';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/** A log row, with only the fields a given test cares about spelled out. */
function entry(overrides: Partial<ReviewLogEntry> = {}): ReviewLogEntry {
  const card = cardLike();
  const base = buildReviewEntry(card, 4, schedule(card, 4, NOW), NOW);
  return { ...base, id: `${base.id}-${Math.random()}`, ...overrides };
}

beforeEach(resetDatabase);

describe('reviewStateOf', () => {
  it('calls a card that has never been seen new', () => {
    expect(reviewStateOf(cardLike())).toBe('new');
  });

  it('distinguishes relearning from learning by whether the card has lapsed', () => {
    const seen = { lastReviewedAt: NOW - DAY_MS };
    expect(reviewStateOf(cardLike({ ...seen, repetitions: 0, lapses: 0 }))).toBe('learning');
    expect(reviewStateOf(cardLike({ ...seen, repetitions: 0, lapses: 3 }))).toBe('relearning');
  });

  it('only calls a card in review once it is past the graduating steps', () => {
    const seen = { lastReviewedAt: NOW - DAY_MS, repetitions: 2 };
    expect(reviewStateOf(cardLike({ ...seen, interval: 1 }))).toBe('learning');
    expect(reviewStateOf(cardLike({ ...seen, interval: 6 }))).toBe('review');
    expect(reviewStateOf(cardLike({ ...seen, interval: 60 }))).toBe('review');
  });
});

describe('buildReviewEntry', () => {
  it('captures the card as it was going in, and the schedule coming out', () => {
    const card = cardLike({ interval: 10, repetitions: 3, lapses: 1, easeFactor: 2.3, dueAt: NOW - DAY_MS });
    const next = schedule(card, 3, NOW);
    const row = buildReviewEntry(card, 3, next, NOW);

    expect(row).toMatchObject({
      cardId: card.id,
      nodeId: card.nodeId,
      kind: card.kind,
      grade: 3,
      reviewedAt: NOW,
      scheduledFor: card.dueAt,
      intervalBefore: 10,
      intervalAfter: next.interval,
      easeBefore: 2.3,
      easeAfter: next.easeFactor,
      repetitionsBefore: 3,
      lapsesBefore: 1,
      deletedAt: null,
    });
  });

  it('records how late the review was, via scheduledFor', () => {
    const card = cardLike({ dueAt: NOW - 3 * DAY_MS, lastReviewedAt: NOW - 10 * DAY_MS });
    const row = buildReviewEntry(card, 4, schedule(card, 4, NOW), NOW);
    expect(row.reviewedAt - row.scheduledFor).toBe(3 * DAY_MS);
    expect(row.elapsedMs).toBe(10 * DAY_MS);
  });
});

describe('summarizeReviews', () => {
  it('excludes first sightings of new cards from retention', () => {
    // A card you have never studied is not a memory you failed to retain.
    const rows = [
      entry({ state: 'new', grade: 0 }),
      entry({ state: 'review', grade: 4 }),
      entry({ state: 'review', grade: 0 }),
    ];
    const summary = summarizeReviews(rows);
    expect(summary.reviews).toBe(3);
    expect(summary.retention).toBe(0.5);
    expect(summary.lapses).toBe(2);
  });

  it('reports no retention at all rather than zero when nothing qualifies', () => {
    expect(summarizeReviews([entry({ state: 'new' })]).retention).toBeNull();
    expect(summarizeReviews([]).retention).toBeNull();
  });

  it('counts distinct cards, not reviews', () => {
    const rows = [entry({ cardId: 'a' }), entry({ cardId: 'a' }), entry({ cardId: 'b' })];
    expect(summarizeReviews(rows).cards).toBe(2);
    expect(summarizeReviews(rows).reviews).toBe(3);
  });

  it('buckets reviews into local days', () => {
    const noon = new Date(2026, 0, 15, 12, 0, 0).getTime();
    const rows = [
      entry({ reviewedAt: noon }),
      entry({ reviewedAt: noon + 60_000 }),
      entry({ reviewedAt: noon + DAY_MS }),
    ];
    const perDay = summarizeReviews(rows).perDay;
    expect(perDay.get('2026-01-15')).toBe(2);
    expect(perDay.get('2026-01-16')).toBe(1);
  });
});

describe('reading the log', () => {
  it('returns one card history oldest first', async () => {
    await db.reviews.bulkAdd([
      entry({ cardId: 'a', reviewedAt: NOW }),
      entry({ cardId: 'a', reviewedAt: NOW - DAY_MS }),
      entry({ cardId: 'b', reviewedAt: NOW }),
    ]);
    const history = await getReviewsForCard('a');
    expect(history.map((r) => r.reviewedAt)).toEqual([NOW - DAY_MS, NOW]);
  });

  it('reads a window inclusively at both ends', async () => {
    await db.reviews.bulkAdd([
      entry({ reviewedAt: NOW - 10 * DAY_MS }),
      entry({ reviewedAt: NOW - 5 * DAY_MS }),
      entry({ reviewedAt: NOW }),
    ]);
    const window = await getReviewsBetween(NOW - 5 * DAY_MS, NOW);
    expect(window).toHaveLength(2);
  });

  it('summarises a recent window without touching older rows', async () => {
    await db.reviews.bulkAdd([
      entry({ reviewedAt: NOW - 60 * DAY_MS }),
      entry({ reviewedAt: NOW - DAY_MS }),
    ]);
    expect((await getRecentReviewSummary(30, NOW)).reviews).toBe(1);
    expect(await getAllReviews()).toHaveLength(2);
  });

  it('hides a tombstoned row, which should never exist but would break stats if it did', async () => {
    await db.reviews.bulkAdd([entry({ cardId: 'a' }), entry({ cardId: 'a', deletedAt: NOW })]);
    expect(await getReviewsForCard('a')).toHaveLength(1);
    expect(await getAllReviews()).toHaveLength(1);
  });
});
