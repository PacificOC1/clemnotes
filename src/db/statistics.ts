import { getAllCards } from './cardRepository';
import { dayKey, getReviewsBetween, summarizeReviews, type ReviewSummary } from './reviewRepository';
import type { Flashcard } from './schema';

/**
 * The numbers behind the Flashcards statistics view.
 *
 * Everything here is derived — from the review log for what has happened, and
 * from card state for what is about to. Nothing is stored, so the view can
 * never disagree with the data, and the shapes below are deliberately plain
 * arrays so the rendering layer does no arithmetic of its own.
 *
 * The four figures worth having, in the order they change behaviour:
 * retention (is the reviewing working), reviews per day (are you turning up),
 * the due forecast (what is about to land on you), and the interval
 * distribution (is anything actually reaching long-term memory).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DayPoint {
  /** Local `YYYY-MM-DD`, the key `summarizeReviews` buckets on. */
  day: string;
  /** Midnight local time, for formatting axis labels. */
  at: number;
  count: number;
}

export interface IntervalBucket {
  label: string;
  /** Inclusive lower bound in days; `null` max means open-ended. */
  min: number;
  max: number | null;
  count: number;
}

export interface ForecastDay extends DayPoint {
  /** Everything due on or before this day, if you clear the queue daily. */
  cumulative: number;
}

/** Local midnight for the day containing `at`. */
function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The last `days` days as a dense series, today last.
 *
 * Dense matters: a bar chart drawn only from the days you reviewed makes a
 * fortnight off look like a fortnight of work, because the gap is where the
 * information is.
 */
export function dailySeries(perDay: Map<string, number>, days: number, now = Date.now()): DayPoint[] {
  const today = startOfDay(now);
  const out: DayPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    // Built by subtracting whole days from local midnight and re-normalising,
    // so a daylight-saving boundary inside the window can't shift the buckets.
    const at = startOfDay(today - i * DAY_MS);
    out.push({ day: dayKey(at), at, count: perDay.get(dayKey(at)) ?? 0 });
  }
  return out;
}

const BUCKETS: Array<Omit<IntervalBucket, 'count'>> = [
  { label: 'New', min: 0, max: 0 },
  { label: '1d', min: 1, max: 1 },
  { label: '2–6d', min: 2, max: 6 },
  { label: '1–3w', min: 7, max: 20 },
  { label: '3w–3mo', min: 21, max: 89 },
  { label: '3mo+', min: 90, max: null },
];

/**
 * How the collection is spread across interval lengths.
 *
 * The shape is the diagnosis: a pile stuck at the short end means cards are
 * being failed and reset rather than learned, which no single retention
 * percentage will tell you.
 */
export function intervalDistribution(cards: Flashcard[]): IntervalBucket[] {
  return BUCKETS.map((bucket) => ({
    ...bucket,
    count: cards.filter((card) => {
      const days = card.lastReviewedAt === null ? 0 : card.interval;
      return days >= bucket.min && (bucket.max === null || days <= bucket.max);
    }).length,
  }));
}

/**
 * What is due over the next `days` days, assuming you clear the queue daily.
 *
 * Anything already due — including cards overdue by months — lands on the
 * first day, because that is where it will actually land. The cumulative
 * figure is the one that warns you: a spike four days out is easy to miss when
 * each individual day looks manageable.
 */
export function dueForecast(cards: Flashcard[], days: number, now = Date.now()): ForecastDay[] {
  const today = startOfDay(now);
  const counts = new Array<number>(days).fill(0);

  for (const card of cards) {
    if (card.suspended) continue;
    const index = Math.floor((startOfDay(card.dueAt) - today) / DAY_MS);
    if (index >= days) continue;
    counts[Math.max(0, index)] += 1;
  }

  let running = 0;
  return counts.map((count, i) => {
    running += count;
    const at = startOfDay(today + i * DAY_MS);
    return { day: dayKey(at), at, count, cumulative: running };
  });
}

export interface Statistics {
  /** Summary of the review log over the window. */
  summary: ReviewSummary;
  windowDays: number;
  reviewsPerDay: DayPoint[];
  forecast: ForecastDay[];
  intervals: IntervalBucket[];
  /** Cards due right now, including everything overdue. */
  dueNow: number;
  /** Cards with an interval of three weeks or more. */
  mature: number;
  total: number;
  /** Consecutive days up to today with at least one review. */
  streak: number;
}

/** Days ending today on which at least one review happened. */
export function currentStreak(series: DayPoint[]): number {
  let streak = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    if ((series[i]?.count ?? 0) === 0) break;
    streak += 1;
  }
  return streak;
}

/** Read everything the statistics view needs in two table reads. */
export async function loadStatistics(
  windowDays = 30,
  forecastDays = 30,
  now = Date.now()
): Promise<Statistics> {
  const [cards, reviews] = await Promise.all([
    getAllCards(),
    getReviewsBetween(startOfDay(now) - (windowDays - 1) * DAY_MS, now),
  ]);

  const summary = summarizeReviews(reviews);
  const reviewsPerDay = dailySeries(summary.perDay, windowDays, now);

  return {
    summary,
    windowDays,
    reviewsPerDay,
    forecast: dueForecast(cards, forecastDays, now),
    intervals: intervalDistribution(cards),
    dueNow: cards.filter((c) => !c.suspended && c.dueAt <= now).length,
    mature: cards.filter((c) => c.interval >= 21).length,
    total: cards.length,
    streak: currentStreak(reviewsPerDay),
  };
}
