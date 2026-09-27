import { FSRSAlgorithm, clipParameters, default_w, forgetting_curve, generatorParameters } from 'ts-fsrs';
import type { Flashcard } from '../db/schema';
import type { ScheduleUpdate } from './sm2';

/**
 * FSRS scheduling.
 *
 * SM-2 keeps one number per card (ease) and so cannot tell "this card is hard"
 * from "I forget things quickly". FSRS models memory with two — difficulty,
 * and stability (the days until recall drops to 90%) — and schedules the next
 * review for the day recall is predicted to reach the retention you asked for.
 * The maths comes from `ts-fsrs` (FSRS-6, the reference TypeScript port); this
 * file decides how it meets the rest of the app.
 *
 * **The memory state is never stored.** It is replayed from the card's review
 * log every time it is needed. That has three consequences, all deliberate:
 *
 * - No new columns on `cards`, so no Supabase migration, and card sync keeps
 *   working for anyone who hasn't run one.
 * - Every card reviewed under SM-2 moves to FSRS with its real history rather
 *   than a guess — the review log (#29) exists precisely so this was possible.
 * - Re-fitting the parameters to your history (`optimizeParameters`) changes
 *   every card's schedule at once, with nothing to migrate.
 *
 * A reset card starts its history again from `card.createdAt`, which a reset
 * moves to the moment of the reset — the log itself is append-only and keeps
 * every review that happened.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A forgotten card comes back in ten minutes, as it does under SM-2. */
const RELEARN_MS = 10 * 60 * 1000;
const MAX_INTERVAL_DAYS = 36500;

export const DEFAULT_PARAMETERS: readonly number[] = default_w;
export const DEFAULT_RETENTION = 0.9;

export interface MemoryState {
  stability: number;
  difficulty: number;
}

/** What the replay needs from a review: when, and how it went (SM-2 quality 0–5). */
export interface HistoryPoint {
  reviewedAt: number;
  grade: number;
}

export interface FsrsOptions {
  parameters: readonly number[];
  retention: number;
}

export const DEFAULT_FSRS: FsrsOptions = { parameters: DEFAULT_PARAMETERS, retention: DEFAULT_RETENTION };

/** SM-2 quality → FSRS rating. The app's four buttons log 0, 3, 4 and 5. */
export function ratingFor(quality: number): 1 | 2 | 3 | 4 {
  if (quality < 3) return 1;
  if (quality === 3) return 2;
  if (quality === 4) return 3;
  return 4;
}

const algorithms = new Map<string, FSRSAlgorithm>();

function algorithmFor(options: FsrsOptions): FSRSAlgorithm {
  const key = `${options.retention}|${options.parameters.join(',')}`;
  let algorithm = algorithms.get(key);
  if (!algorithm) {
    algorithm = new FSRSAlgorithm(
      generatorParameters({
        w: [...options.parameters],
        request_retention: options.retention,
        maximum_interval: MAX_INTERVAL_DAYS,
        enable_fuzz: false,
        enable_short_term: true,
      })
    );
    if (algorithms.size > 8) algorithms.clear();
    algorithms.set(key, algorithm);
  }
  return algorithm;
}

/** Whole days between two moments — FSRS counts in days, and a same-day review is day 0. */
function elapsedDays(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / DAY_MS));
}

export interface Replayed {
  state: MemoryState | null;
  lastReviewedAt: number | null;
}

/** The memory state a history leaves a card in. `null` state = never reviewed. */
export function replay(history: readonly HistoryPoint[], options: FsrsOptions = DEFAULT_FSRS): Replayed {
  const algorithm = algorithmFor(options);
  let state: MemoryState | null = null;
  let last: number | null = null;
  for (const point of [...history].sort((a, b) => a.reviewedAt - b.reviewedAt)) {
    const t = last === null ? 0 : elapsedDays(last, point.reviewedAt);
    state = algorithm.next_state(state, t, ratingFor(point.grade));
    last = point.reviewedAt;
  }
  return { state, lastReviewedAt: last };
}

/** The reviews that count toward a card's current schedule: everything since it was (re)started. */
export function historySince(card: Pick<Flashcard, 'createdAt'>, reviews: readonly HistoryPoint[]): HistoryPoint[] {
  return reviews.filter((r) => r.reviewedAt >= card.createdAt);
}

/** Days until the next review, for a card in `state` after `t` days. */
function intervalFor(algorithm: FSRSAlgorithm, state: MemoryState, t: number): number {
  const days = algorithm.next_interval(state.stability, t);
  return Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(days)));
}

/**
 * Apply one review. Same shape as SM-2's `schedule`, so grading, the review
 * log and everything that reads a card's `interval` are unchanged.
 *
 * `easeFactor` is carried through untouched: FSRS doesn't use it, and keeping
 * it means switching back to SM-2 picks up where SM-2 left off.
 */
export function fsrsSchedule(
  card: Flashcard,
  history: readonly HistoryPoint[],
  quality: number,
  now = Date.now(),
  options: FsrsOptions = DEFAULT_FSRS
): ScheduleUpdate & { memory: MemoryState } {
  const algorithm = algorithmFor(options);
  const before = replay(history, options);
  const t = before.lastReviewedAt === null ? 0 : elapsedDays(before.lastReviewedAt, now);
  const rating = ratingFor(quality);
  const memory = algorithm.next_state(before.state, t, rating);

  if (rating === 1) {
    return {
      easeFactor: card.easeFactor,
      intervalDays: 0,
      repetitions: 0,
      lapses: card.lapses + 1,
      dueAt: now + RELEARN_MS,
      lastReviewedAt: now,
      memory,
    };
  }

  const interval = intervalFor(algorithm, memory, t);
  return {
    easeFactor: card.easeFactor,
    intervalDays: interval,
    repetitions: card.repetitions + 1,
    lapses: card.lapses,
    dueAt: now + interval * DAY_MS,
    lastReviewedAt: now,
    memory,
  };
}

/** Button labels: when each answer would bring the card back. */
export function previewFsrs(
  card: Flashcard,
  history: readonly HistoryPoint[],
  quality: number,
  now = Date.now(),
  options: FsrsOptions = DEFAULT_FSRS
): string {
  const next = fsrsSchedule(card, history, quality, now, options);
  if (next.intervalDays < 1) return '10m';
  return formatDays(next.intervalDays);
}

export function formatDays(days: number): string {
  if (days === 1) return '1d';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

/** Predicted chance of recalling a card right now, 0–1. */
export function recallProbability(replayed: Replayed, now = Date.now(), options: FsrsOptions = DEFAULT_FSRS): number | null {
  if (!replayed.state || replayed.lastReviewedAt === null) return null;
  return forgetting_curve([...options.parameters], (now - replayed.lastReviewedAt) / DAY_MS, replayed.state.stability);
}

// ---------------------------------------------------------------- optimiser

/**
 * How well a set of parameters predicts what actually happened: the mean log
 * loss of "will I remember this?" over every review that came at least a day
 * after the one before (same-day reviews are learning steps, not recall).
 * Lower is better.
 */
export function logLoss(histories: readonly (readonly HistoryPoint[])[], parameters: readonly number[]): number {
  const algorithm = algorithmFor({ parameters, retention: DEFAULT_RETENTION });
  let total = 0;
  let count = 0;
  for (const history of histories) {
    let state: MemoryState | null = null;
    let last: number | null = null;
    for (const point of history) {
      const rating = ratingFor(point.grade);
      const t = last === null ? 0 : elapsedDays(last, point.reviewedAt);
      if (state && t >= 1) {
        const p = Math.min(1 - 1e-6, Math.max(1e-6, forgetting_curve([...parameters], t, state.stability)));
        const recalled = rating > 1 ? 1 : 0;
        total -= recalled * Math.log(p) + (1 - recalled) * Math.log(1 - p);
        count += 1;
      }
      state = algorithm.next_state(state, t, rating);
      last = point.reviewedAt;
    }
  }
  return count === 0 ? 0 : total / count;
}

/** Reviews the loss can learn from — how much evidence there is. */
export function countEvidence(histories: readonly (readonly HistoryPoint[])[]): number {
  let n = 0;
  for (const history of histories) {
    for (let i = 1; i < history.length; i++) {
      if (elapsedDays(history[i - 1]!.reviewedAt, history[i]!.reviewedAt) >= 1) n += 1;
    }
  }
  return n;
}

/** Below this, the defaults (fitted on millions of reviews) beat anything fitted to yours. */
export const MIN_EVIDENCE = 200;

export interface OptimizeResult {
  parameters: number[];
  lossBefore: number;
  lossAfter: number;
  evidence: number;
  /** False when fitting didn't beat what you had — the caller should keep the old parameters. */
  improved: boolean;
}

/**
 * Fit the parameters to your own history.
 *
 * Plain gradient descent with finite-difference gradients (Adam, clipped to
 * FSRS's legal ranges after every step). The reference optimiser is a Rust
 * crate with autodiff; this is slower and simpler, but a notebook's worth of
 * reviews is small enough that it converges in seconds, and it only runs when
 * asked. It yields between iterations so the page stays responsive, and only
 * reports an improvement when the fitted parameters actually predict your
 * reviews better than the starting ones.
 */
export async function optimizeParameters(
  histories: readonly (readonly HistoryPoint[])[],
  start: readonly number[] = DEFAULT_PARAMETERS,
  options: { iterations?: number; onProgress?: (fraction: number) => void } = {}
): Promise<OptimizeResult> {
  const sorted = histories.map((h) => [...h].sort((a, b) => a.reviewedAt - b.reviewedAt));
  const evidence = countEvidence(sorted);
  const lossBefore = logLoss(sorted, start);
  const iterations = options.iterations ?? 40;

  let params = [...start];
  if (evidence < MIN_EVIDENCE) {
    return { parameters: params, lossBefore, lossAfter: lossBefore, evidence, improved: false };
  }

  const clip = (w: number[]) => clipParameters(w, 1, true);
  const m = new Array<number>(params.length).fill(0);
  const v = new Array<number>(params.length).fill(0);
  const lr = 0.04;
  const [b1, b2, eps] = [0.9, 0.999, 1e-8];

  for (let step = 1; step <= iterations; step++) {
    const base = logLoss(sorted, params);
    const grad = params.map((value, i) => {
      const h = Math.max(1e-4, Math.abs(value) * 1e-3);
      const bumped = [...params];
      bumped[i] = value + h;
      return (logLoss(sorted, clip(bumped)) - base) / h;
    });
    params = clip(
      params.map((value, i) => {
        m[i] = b1 * m[i]! + (1 - b1) * grad[i]!;
        v[i] = b2 * v[i]! + (1 - b2) * grad[i]! ** 2;
        const mHat = m[i]! / (1 - b1 ** step);
        const vHat = v[i]! / (1 - b2 ** step);
        // Scale the step to the parameter: w3 is ~8, w7 is ~0.001.
        const scale = Math.max(0.05, Math.abs(value));
        return value - lr * scale * (mHat / (Math.sqrt(vHat) + eps));
      })
    );
    options.onProgress?.(step / iterations);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const lossAfter = logLoss(sorted, params);
  const improved = lossAfter < lossBefore - 1e-4;
  return { parameters: improved ? params : [...start], lossBefore, lossAfter, evidence, improved };
}
