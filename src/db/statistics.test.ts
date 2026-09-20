import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import {
  currentStreak,
  dailySeries,
  dueForecast,
  intervalDistribution,
  loadStatistics,
} from './statistics';
import { dayKey } from './reviewRepository';
import { cardLike, resetDatabase } from '../test/helpers';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Midday, so adding or subtracting whole days never lands on a boundary. */
const NOW = new Date(2026, 4, 20, 12, 0, 0).getTime();

function daysAgo(n: number): number {
  return NOW - n * DAY_MS;
}

beforeEach(resetDatabase);

describe('dailySeries', () => {
  it('returns a dense series ending today', () => {
    const series = dailySeries(new Map(), 7, NOW);
    expect(series).toHaveLength(7);
    expect(series[6]?.day).toBe(dayKey(NOW));
    expect(series[0]?.day).toBe(dayKey(daysAgo(6)));
    // A day with nothing in it is a real zero, not a missing point: the gaps
    // are exactly what a "have I been turning up" chart is for.
    expect(series.every((p) => p.count === 0)).toBe(true);
  });

  it('places counts on the right days', () => {
    const perDay = new Map([
      [dayKey(NOW), 5],
      [dayKey(daysAgo(2)), 3],
      [dayKey(daysAgo(40)), 99], // outside the window
    ]);
    const series = dailySeries(perDay, 7, NOW);
    expect(series.map((p) => p.count)).toEqual([0, 0, 0, 0, 3, 0, 5]);
  });

  it('starts each point at local midnight', () => {
    for (const point of dailySeries(new Map(), 3, NOW)) {
      const d = new Date(point.at);
      expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([0, 0, 0]);
    }
  });
});

describe('intervalDistribution', () => {
  it('sorts cards into buckets by interval, counting unseen cards as new', () => {
    const cards = [
      cardLike({ id: '1', interval: 0 }),
      cardLike({ id: '2', interval: 200, lastReviewedAt: null }), // never seen: still new
      cardLike({ id: '3', interval: 1, lastReviewedAt: NOW }),
      cardLike({ id: '4', interval: 5, lastReviewedAt: NOW }),
      cardLike({ id: '5', interval: 14, lastReviewedAt: NOW }),
      cardLike({ id: '6', interval: 45, lastReviewedAt: NOW }),
      cardLike({ id: '7', interval: 400, lastReviewedAt: NOW }),
    ];
    expect(intervalDistribution(cards).map((b) => [b.label, b.count])).toEqual([
      ['New', 2],
      ['1d', 1],
      ['2–6d', 1],
      ['1–3w', 1],
      ['3w–3mo', 1],
      ['3mo+', 1],
    ]);
  });

  it('puts every card in exactly one bucket', () => {
    const cards = Array.from({ length: 50 }, (_, i) =>
      cardLike({ id: `c${i}`, interval: i * 7, lastReviewedAt: NOW })
    );
    const total = intervalDistribution(cards).reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(cards.length);
  });
});

describe('dueForecast', () => {
  it('lands everything already overdue on the first day', () => {
    const cards = [
      cardLike({ id: 'a', dueAt: daysAgo(90) }),
      cardLike({ id: 'b', dueAt: daysAgo(1) }),
      cardLike({ id: 'c', dueAt: NOW }),
    ];
    const forecast = dueForecast(cards, 5, NOW);
    expect(forecast[0]?.count).toBe(3);
    expect(forecast.slice(1).every((d) => d.count === 0)).toBe(true);
  });

  it('spreads future cards across the days they are due', () => {
    const cards = [
      cardLike({ id: 'a', dueAt: NOW + DAY_MS }),
      cardLike({ id: 'b', dueAt: NOW + DAY_MS }),
      cardLike({ id: 'c', dueAt: NOW + 3 * DAY_MS }),
    ];
    expect(dueForecast(cards, 5, NOW).map((d) => d.count)).toEqual([0, 2, 0, 1, 0]);
  });

  it('accumulates, because a spike is what the forecast is for', () => {
    const cards = [
      cardLike({ id: 'a', dueAt: NOW }),
      cardLike({ id: 'b', dueAt: NOW + DAY_MS }),
      cardLike({ id: 'c', dueAt: NOW + DAY_MS }),
    ];
    expect(dueForecast(cards, 4, NOW).map((d) => d.cumulative)).toEqual([1, 3, 3, 3]);
  });

  it('ignores suspended cards and anything beyond the window', () => {
    const cards = [
      cardLike({ id: 'a', dueAt: NOW, suspended: true }),
      cardLike({ id: 'b', dueAt: NOW + 400 * DAY_MS }),
      cardLike({ id: 'c', dueAt: NOW }),
    ];
    const forecast = dueForecast(cards, 5, NOW);
    expect(forecast[0]?.count).toBe(1);
    expect(forecast[forecast.length - 1]?.cumulative).toBe(1);
  });
});

describe('currentStreak', () => {
  it('counts back from today and stops at the first empty day', () => {
    const series = dailySeries(
      new Map([
        [dayKey(NOW), 4],
        [dayKey(daysAgo(1)), 2],
        [dayKey(daysAgo(3)), 9],
      ]),
      7,
      NOW
    );
    expect(currentStreak(series)).toBe(2);
  });

  it('is zero when today is empty, however good yesterday was', () => {
    const series = dailySeries(new Map([[dayKey(daysAgo(1)), 50]]), 7, NOW);
    expect(currentStreak(series)).toBe(0);
  });
});

describe('loadStatistics', () => {
  it('reads cards and the log into one snapshot', async () => {
    await db.cards.bulkAdd([
      cardLike({ id: 'due', dueAt: NOW - DAY_MS, interval: 30, lastReviewedAt: daysAgo(30) }),
      cardLike({ id: 'later', dueAt: NOW + 2 * DAY_MS, interval: 3, lastReviewedAt: daysAgo(1) }),
      cardLike({ id: 'asleep', dueAt: NOW - DAY_MS, suspended: true, interval: 0 }),
    ]);

    const stats = await loadStatistics(30, 30, NOW);

    expect(stats.total).toBe(3);
    expect(stats.dueNow).toBe(1); // the suspended one is not waiting for you
    expect(stats.mature).toBe(1);
    expect(stats.reviewsPerDay).toHaveLength(30);
    expect(stats.forecast).toHaveLength(30);
    expect(stats.intervals.reduce((sum, b) => sum + b.count, 0)).toBe(3);
    expect(stats.summary.reviews).toBe(0);
    expect(stats.streak).toBe(0);
  });
});
