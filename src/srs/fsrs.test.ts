import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMETERS,
  MIN_EVIDENCE,
  countEvidence,
  fsrsSchedule,
  historySince,
  logLoss,
  optimizeParameters,
  previewFsrs,
  ratingFor,
  recallProbability,
  replay,
  type HistoryPoint,
} from './fsrs';
import { cardLike, resetDatabase } from '../test/helpers';
import { db } from '../db/database';
import { gradeCard, resetCard } from '../db/cardRepository';
import { getReviewsForCard } from '../db/reviewRepository';
import { DEFAULT_SETTINGS } from './settings';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1, 9);

const at = (day: number, grade: number): HistoryPoint => ({ reviewedAt: T0 + day * DAY, grade });

describe('ratings', () => {
  it('maps the four buttons onto FSRS ratings', () => {
    expect([0, 3, 4, 5].map(ratingFor)).toEqual([1, 2, 3, 4]);
  });
});

describe('replaying a history', () => {
  it('starts from nothing', () => {
    expect(replay([])).toEqual({ state: null, lastReviewedAt: null });
  });

  it('first Good gives the default initial stability for Good', () => {
    const { state } = replay([at(0, 4)]);
    expect(state!.stability).toBeCloseTo(DEFAULT_PARAMETERS[2]!, 5);
  });

  it('grows stability with successful reviews and shrinks it on a lapse', () => {
    const good = replay([at(0, 4), at(3, 4), at(15, 4)]).state!;
    const lapsed = replay([at(0, 4), at(3, 4), at(15, 0)]).state!;
    const afterTwo = replay([at(0, 4), at(3, 4)]).state!;
    expect(good.stability).toBeGreaterThan(afterTwo.stability);
    expect(lapsed.stability).toBeLessThan(afterTwo.stability);
    expect(lapsed.difficulty).toBeGreaterThan(good.difficulty);
  });

  it("doesn't care what order the rows arrive in", () => {
    const a = replay([at(0, 4), at(3, 3), at(10, 5)]);
    const b = replay([at(10, 5), at(0, 4), at(3, 3)]);
    expect(a).toEqual(b);
  });

  it('predicts recall falling as time passes', () => {
    const replayed = replay([at(0, 4), at(3, 4)]);
    const soon = recallProbability(replayed, T0 + 4 * DAY)!;
    const later = recallProbability(replayed, T0 + 60 * DAY)!;
    expect(soon).toBeGreaterThan(later);
    expect(soon).toBeLessThanOrEqual(1);
  });
});

describe('scheduling', () => {
  const card = cardLike({ id: 'c', lastReviewedAt: null, repetitions: 0, lapses: 0, createdAt: T0 });

  it('sends Again back in ten minutes and counts the lapse', () => {
    const next = fsrsSchedule(card, [], 0, T0);
    expect(next.dueAt - T0).toBe(10 * 60 * 1000);
    expect(next.intervalDays).toBe(0);
    expect(next.lapses).toBe(1);
  });

  it('orders the intervals Hard ≤ Good ≤ Easy, at least a day', () => {
    const history = [at(0, 4)];
    const reviewed = { ...card, lastReviewedAt: T0, repetitions: 1 };
    const [hard, good, easy] = [3, 4, 5].map((q) => fsrsSchedule(reviewed, history, q, T0 + 3 * DAY).intervalDays);
    expect(hard).toBeGreaterThanOrEqual(1);
    expect(hard!).toBeLessThanOrEqual(good!);
    expect(good!).toBeLessThanOrEqual(easy!);
  });

  it('asks for sooner reviews when you want to remember more', () => {
    const history = [at(0, 4), at(3, 4)];
    const reviewed = { ...card, lastReviewedAt: T0 + 3 * DAY, repetitions: 2 };
    const relaxed = fsrsSchedule(reviewed, history, 4, T0 + 20 * DAY, { parameters: DEFAULT_PARAMETERS, retention: 0.8 });
    const strict = fsrsSchedule(reviewed, history, 4, T0 + 20 * DAY, { parameters: DEFAULT_PARAMETERS, retention: 0.95 });
    expect(strict.intervalDays).toBeLessThan(relaxed.intervalDays);
  });

  it('leaves the SM-2 ease alone, so switching back picks up where it was', () => {
    expect(fsrsSchedule({ ...card, easeFactor: 2.1 }, [], 4, T0).easeFactor).toBe(2.1);
  });

  it('labels the buttons', () => {
    expect(previewFsrs(card, [], 0, T0)).toBe('10m');
    expect(previewFsrs(card, [], 4, T0)).toMatch(/^\d+(d|mo)$/);
  });

  it('only counts history since the card was (re)started', () => {
    const history = [at(0, 4), at(5, 4)];
    expect(historySince({ createdAt: T0 + 2 * DAY }, history)).toEqual([history[1]]);
  });
});

describe('grading through the database', () => {
  beforeEach(resetDatabase);

  it('uses FSRS by default and logs the review', async () => {
    await db.cards.add(cardLike({ id: 'card', createdAt: T0, dueAt: T0, lastReviewedAt: null }));
    await gradeCard('card', 4, DEFAULT_SETTINGS, T0);
    const graded = (await db.cards.get('card'))!;
    expect(graded.intervalDays).toBe(Math.round(DEFAULT_PARAMETERS[2]!));
    expect(await getReviewsForCard('card')).toHaveLength(1);
  });

  it('still schedules with SM-2 when asked to', async () => {
    await db.cards.add(cardLike({ id: 'card', createdAt: T0, dueAt: T0, lastReviewedAt: null }));
    await gradeCard('card', 4, { ...DEFAULT_SETTINGS, scheduler: 'sm2' }, T0);
    expect((await db.cards.get('card'))!.intervalDays).toBe(1);
  });

  it('starts FSRS afresh after a reset, keeping the log', async () => {
    await db.cards.add(cardLike({ id: 'card', createdAt: T0 - 30 * DAY, dueAt: T0, lastReviewedAt: null }));
    await gradeCard('card', 0, DEFAULT_SETTINGS, T0 - 20 * DAY);
    await gradeCard('card', 0, DEFAULT_SETTINGS, T0 - 10 * DAY);
    await resetCard('card');
    const fresh = (await db.cards.get('card'))!;
    await gradeCard('card', 4, DEFAULT_SETTINGS, fresh.createdAt + 1000);
    // As if it had never been failed: the first-Good stability.
    expect((await db.cards.get('card'))!.intervalDays).toBe(Math.round(DEFAULT_PARAMETERS[2]!));
    expect(await getReviewsForCard('card')).toHaveLength(3);
  });
});

describe('fitting parameters', () => {
  /** A forgetful learner: fails any gap over `limit` days, with occasional slips. */
  function synthetic(cards: number, limit: number): HistoryPoint[][] {
    const out: HistoryPoint[][] = [];
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let c = 0; c < cards; c++) {
      const history: HistoryPoint[] = [at(0, 4)];
      let day = 0;
      let gap = 1;
      for (let r = 0; r < 6; r++) {
        day += gap;
        const remembered = gap <= limit && rand() > 0.1;
        history.push(at(day, remembered ? 4 : 0));
        gap = remembered ? gap * 2 + 1 : 1;
      }
      out.push(history);
    }
    return out;
  }

  it('counts only reviews a day or more apart as evidence', () => {
    expect(countEvidence([[at(0, 4), at(0.2, 4), at(3, 4)]])).toBe(1);
  });

  it('refuses to fit with too little history', async () => {
    const result = await optimizeParameters(synthetic(5, 4));
    expect(result.evidence).toBeLessThan(MIN_EVIDENCE);
    expect(result.improved).toBe(false);
    expect(result.parameters).toEqual([...DEFAULT_PARAMETERS]);
  });

  it('fits a history better than the defaults do', async () => {
    const histories = synthetic(60, 4);
    const result = await optimizeParameters(histories, DEFAULT_PARAMETERS, { iterations: 12 });
    expect(result.evidence).toBeGreaterThanOrEqual(MIN_EVIDENCE);
    expect(result.improved).toBe(true);
    expect(result.lossAfter).toBeLessThan(result.lossBefore);
    expect(logLoss(histories, result.parameters)).toBeCloseTo(result.lossAfter, 6);
  }, 30_000);
});
