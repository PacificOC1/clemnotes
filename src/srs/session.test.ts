import { describe, expect, it } from 'vitest';
import { isLeech, planPractice, planSession } from './session';
import { DEFAULT_SETTINGS, normalizeSettings, type ReviewSettings } from './settings';
import { cardLike } from '../test/helpers';

const NOW = 1_700_000_000_000;

/** A card that has been seen before, so it counts against the review limit. */
function seen(id: string, nodeId = id, extra = {}) {
  return cardLike({ id, nodeId, lastReviewedAt: NOW - 86_400_000, interval: 5, ...extra });
}

/** A card being seen for the first time. */
function fresh(id: string, nodeId = id) {
  return cardLike({ id, nodeId, lastReviewedAt: null });
}

const unlimited: ReviewSettings = {
  newPerDay: null,
  reviewsPerDay: null,
  leechThreshold: null,
  burySiblings: false,
};

describe('planSession', () => {
  it('passes everything through when nothing is limited', () => {
    const due = [seen('a'), fresh('b'), seen('c')];
    const plan = planSession(due, unlimited);
    expect(plan.queue.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(plan).toMatchObject({ newCount: 1, reviewCount: 2, heldByLimit: 0, heldBySiblings: 0 });
  });

  it('keeps the order it was given, so the most overdue card stays first', () => {
    const due = [seen('old'), seen('newer'), fresh('n')];
    expect(planSession(due, unlimited).queue.map((c) => c.id)).toEqual(['old', 'newer', 'n']);
  });

  it('gives new and seen cards separate allowances', () => {
    // A backlog of reviews must not starve you of new material, and a pile of
    // new cards must not crowd out the reviews that keep the rest alive.
    const due = [seen('r1'), seen('r2'), seen('r3'), fresh('n1'), fresh('n2')];
    const plan = planSession(due, { ...unlimited, newPerDay: 1, reviewsPerDay: 2 });
    expect(plan.queue.map((c) => c.id)).toEqual(['r1', 'r2', 'n1']);
    expect(plan).toMatchObject({ newCount: 1, reviewCount: 2, heldByLimit: 2 });
  });

  it('counts what today already contained against the limit', () => {
    const due = [seen('r1'), seen('r2'), fresh('n1')];
    const plan = planSession(
      due,
      { ...unlimited, newPerDay: 5, reviewsPerDay: 5 },
      { newSeen: 5, reviewsDone: 4 }
    );
    expect(plan.queue.map((c) => c.id)).toEqual(['r1']);
    expect(plan.heldByLimit).toBe(2);
  });

  it('holds everything back once the day is spent', () => {
    const plan = planSession(
      [seen('r1'), fresh('n1')],
      { ...unlimited, newPerDay: 1, reviewsPerDay: 1 },
      { newSeen: 9, reviewsDone: 9 }
    );
    expect(plan.queue).toEqual([]);
    expect(plan.heldByLimit).toBe(2);
  });

  it('shows one card per rem when burying siblings', () => {
    // Three blanks in one sentence: answering the first gives away the rest.
    const due = [seen('c1', 'rem'), seen('c2', 'rem'), seen('c3', 'rem'), seen('other', 'other')];
    const plan = planSession(due, { ...unlimited, burySiblings: true });
    expect(plan.queue.map((c) => c.id)).toEqual(['c1', 'other']);
    expect(plan.heldBySiblings).toBe(2);
  });

  it('shows siblings when burying is switched off', () => {
    const due = [seen('c1', 'rem'), seen('c2', 'rem')];
    const plan = planSession(due, { ...unlimited, burySiblings: false });
    expect(plan.queue).toHaveLength(2);
    expect(plan.heldBySiblings).toBe(0);
  });

  it('does not let a buried sibling eat the daily allowance', () => {
    const due = [seen('c1', 'rem'), seen('c2', 'rem'), seen('c3', 'other')];
    const plan = planSession(due, { ...unlimited, burySiblings: true, reviewsPerDay: 2 });
    expect(plan.queue.map((c) => c.id)).toEqual(['c1', 'c3']);
    expect(plan).toMatchObject({ heldBySiblings: 1, heldByLimit: 0 });
  });

  it('handles an empty queue without inventing anything', () => {
    expect(planSession([], DEFAULT_SETTINGS)).toMatchObject({
      queue: [],
      newCount: 0,
      reviewCount: 0,
      heldByLimit: 0,
      heldBySiblings: 0,
    });
  });
});

describe('isLeech', () => {
  it('flags a card at the threshold, not one short of it', () => {
    expect(isLeech(cardLike({ lapses: 7 }), 8)).toBe(false);
    expect(isLeech(cardLike({ lapses: 8 }), 8)).toBe(true);
    expect(isLeech(cardLike({ lapses: 40 }), 8)).toBe(true);
  });

  it('is off entirely when there is no threshold', () => {
    expect(isLeech(cardLike({ lapses: 100 }), null)).toBe(false);
  });
});

describe('planPractice', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'].map((id) => cardLike({ id, nodeId: id }));

  it('draws on cards that are not due, because that is the point', () => {
    const future = cardLike({ id: 'later', dueAt: NOW + 400 * 86_400_000 });
    expect(planPractice([future], 10).map((c) => c.id)).toEqual(['later']);
  });

  it('leaves suspended cards out', () => {
    const cards = [...pool, cardLike({ id: 'asleep', suspended: true })];
    expect(planPractice(cards, 99).map((c) => c.id)).not.toContain('asleep');
  });

  it('caps the session and keeps every card distinct', () => {
    const picked = planPractice(pool, 3);
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((c) => c.id)).size).toBe(3);
  });

  it('shuffles rather than taking the first n', () => {
    // A generator pinned to 0 makes every swap exchange with the head, which
    // is a different order than the input — and still a permutation of it.
    const shuffled = planPractice(pool, 5, () => 0);
    expect(shuffled.map((c) => c.id)).toEqual(['b', 'c', 'd', 'e', 'a']);
    expect(shuffled.map((c) => c.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('leaves the array it was given alone', () => {
    const order = pool.map((c) => c.id);
    planPractice(pool, 5, () => 0);
    expect(pool.map((c) => c.id)).toEqual(order);
  });
});

describe('settings', () => {
  it('treats zero and negative limits as no limit', () => {
    const s = normalizeSettings({ newPerDay: 0, reviewsPerDay: -5, leechThreshold: 0 });
    expect(s.newPerDay).toBeNull();
    expect(s.reviewsPerDay).toBeNull();
    expect(s.leechThreshold).toBeNull();
  });

  it('falls back to defaults for anything unusable', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ newPerDay: 'lots' })).toMatchObject({
      newPerDay: DEFAULT_SETTINGS.newPerDay,
    });
    expect(normalizeSettings({ newPerDay: Number.NaN }).newPerDay).toBe(DEFAULT_SETTINGS.newPerDay);
  });

  it('keeps explicit nulls, which mean "no limit"', () => {
    expect(normalizeSettings({ newPerDay: null }).newPerDay).toBeNull();
  });

  it('rounds a fractional limit down rather than rejecting it', () => {
    expect(normalizeSettings({ newPerDay: 12.7 }).newPerDay).toBe(12);
  });
});
