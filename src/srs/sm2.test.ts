import { describe, expect, it } from 'vitest';
import { DEFAULT_EASE, MIN_EASE, describeDue, previewInterval, schedule } from './sm2';
import { cardLike } from '../test/helpers';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const NOW = 1_700_000_000_000;

/** Apply a run of grades to a fresh card, returning the state after each one. */
function run(qualities: number[], start = cardLike()) {
  let card = start;
  return qualities.map((quality) => {
    const next = schedule(card, quality, NOW);
    card = { ...card, ...next };
    return next;
  });
}

describe('schedule', () => {
  it('produces the known interval table for repeated Good answers', () => {
    // 1 → 6 → interval × ease, which is the SM-2 progression this app is
    // supposed to implement. If this row changes, scheduling changed.
    expect(run([4, 4, 4, 4]).map((s) => s.interval)).toEqual([1, 6, 15, 38]);
  });

  it('graduates an Easy answer to four days rather than one', () => {
    // The deliberate divergence from plain SM-2: without it, Easy and Good are
    // indistinguishable on a card's first review.
    expect(run([5])[0]?.interval).toBe(4);
    expect(run([4])[0]?.interval).toBe(1);
  });

  it('gives Easy a bonus stretch once a card is past the graduating steps', () => {
    const afterTwo = { ...cardLike(), ...run([4, 4])[1]! };
    const good = schedule(afterTwo, 4, NOW);
    const easy = schedule(afterTwo, 5, NOW);
    expect(good.interval).toBe(15);
    expect(easy.interval).toBe(Math.round(15 * 1.3));
  });

  it('brings a lapsed card back in ten minutes, not tomorrow', () => {
    const mature = cardLike({ interval: 30, repetitions: 5, easeFactor: 2.5 });
    const next = schedule(mature, 0, NOW);
    expect(next.dueAt).toBe(NOW + 10 * MINUTE_MS);
    expect(next.interval).toBe(0);
    expect(next.repetitions).toBe(0);
    expect(next.lapses).toBe(1);
  });

  it('counts a lapse once per failure, not once per review', () => {
    expect(run([0, 4, 0]).map((s) => s.lapses)).toEqual([1, 1, 2]);
  });

  it('moves the ease factor in the expected direction', () => {
    expect(run([5])[0]?.easeFactor).toBeGreaterThan(DEFAULT_EASE);
    expect(run([4])[0]?.easeFactor).toBeCloseTo(DEFAULT_EASE, 10);
    expect(run([3])[0]?.easeFactor).toBeLessThan(DEFAULT_EASE);
    expect(run([0])[0]?.easeFactor).toBeLessThan(DEFAULT_EASE);
  });

  it('never lets the ease factor fall below the floor', () => {
    // Without the floor a repeatedly-failed card spirals into being shown
    // constantly, which is the failure mode MIN_EASE exists to prevent.
    const eases = run([0, 0, 0, 0, 0, 0]).map((s) => s.easeFactor);
    expect(Math.min(...eases)).toBeGreaterThanOrEqual(MIN_EASE);
    expect(eases[eases.length - 1]).toBe(MIN_EASE);
  });

  it('schedules a successful review interval days out', () => {
    const next = schedule(cardLike(), 4, NOW);
    expect(next.dueAt).toBe(NOW + 1 * DAY_MS);
    expect(next.lastReviewedAt).toBe(NOW);
  });

  it('never returns an interval below one day for a success', () => {
    const tiny = cardLike({ interval: 1, repetitions: 4, easeFactor: MIN_EASE });
    expect(schedule(tiny, 3, NOW).interval).toBeGreaterThanOrEqual(1);
  });

  it('is pure — the card passed in is not mutated', () => {
    const card = cardLike({ interval: 10, repetitions: 3 });
    const snapshot = { ...card };
    schedule(card, 5, NOW);
    expect(card).toEqual(snapshot);
  });
});

describe('previewInterval', () => {
  it('labels a failure as ten minutes whatever the card', () => {
    expect(previewInterval(cardLike({ interval: 200, repetitions: 9 }), 0)).toBe('10m');
  });

  it('scales its unit with the interval', () => {
    expect(previewInterval(cardLike(), 4)).toBe('1d');
    expect(previewInterval(cardLike({ repetitions: 1 }), 4)).toBe('6d');
    expect(previewInterval(cardLike({ interval: 20, repetitions: 5 }), 4)).toBe('2mo');
    expect(previewInterval(cardLike({ interval: 300, repetitions: 9 }), 4)).toBe('2.1y');
  });
});

describe('describeDue', () => {
  it('describes overdue and upcoming cards', () => {
    expect(describeDue(NOW - 1000, NOW)).toBe('due now');
    expect(describeDue(NOW + 5 * MINUTE_MS, NOW)).toBe('in 5m');
    expect(describeDue(NOW + DAY_MS, NOW)).toBe('tomorrow');
    expect(describeDue(NOW + 5 * DAY_MS, NOW)).toBe('in 5d');
    expect(describeDue(NOW + 90 * DAY_MS, NOW)).toBe('in 3mo');
  });
});
