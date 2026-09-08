import type { Flashcard } from '../db/schema';

/**
 * SM-2 spaced repetition, the algorithm behind SuperMemo 2 / Anki / RemNote.
 *
 * Each card carries an ease factor (how easy you personally find it), an
 * interval in days, and a count of consecutive successes. A good answer
 * multiplies the interval by the ease factor; a failure resets the streak and
 * puts the card back in today's queue. The ease factor itself drifts up when
 * you find a card easy and down when you find it hard, with a 1.3 floor so a
 * genuinely difficult card can never spiral into being shown constantly.
 */

export const DEFAULT_EASE = 2.5;
export const MIN_EASE = 1.3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A lapsed card comes back in ten minutes rather than tomorrow. */
const RELEARN_MS = 10 * 60 * 1000;

export type GradeKey = 'again' | 'hard' | 'good' | 'easy';

export interface Grade {
  key: GradeKey;
  label: string;
  /** SM-2 quality score, 0–5. Below 3 counts as a failure. */
  quality: number;
  hotkey: string;
}

export const GRADES: Grade[] = [
  { key: 'again', label: 'Again', quality: 0, hotkey: '1' },
  { key: 'hard', label: 'Hard', quality: 3, hotkey: '2' },
  { key: 'good', label: 'Good', quality: 4, hotkey: '3' },
  { key: 'easy', label: 'Easy', quality: 5, hotkey: '4' },
];

export interface ScheduleUpdate {
  easeFactor: number;
  interval: number;
  repetitions: number;
  lapses: number;
  dueAt: number;
  lastReviewedAt: number;
}

/** Apply one review to a card's scheduling state. Pure — callers persist the result. */
export function schedule(card: Flashcard, quality: number, now = Date.now()): ScheduleUpdate {
  let { easeFactor, interval, repetitions, lapses } = card;

  if (quality < 3) {
    repetitions = 0;
    lapses += 1;
    interval = 0;
  } else {
    repetitions += 1;
    if (repetitions === 1) {
      // Graduating interval. Plain SM-2 sends every first success to 1 day,
      // which makes "Easy" indistinguishable from "Good" on a new card; a
      // four-day graduation for Easy is the Anki refinement and is far more
      // useful in practice.
      interval = quality === 5 ? 4 : 1;
    } else if (repetitions === 2) {
      interval = 6;
    } else {
      interval = Math.max(1, Math.round(interval * easeFactor));
      // An "easy" answer earns a bonus stretch on top of the normal interval.
      if (quality === 5) interval = Math.round(interval * 1.3);
    }
  }

  easeFactor = Math.max(
    MIN_EASE,
    easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
  );

  return {
    easeFactor,
    interval,
    repetitions,
    lapses,
    dueAt: quality < 3 ? now + RELEARN_MS : now + interval * DAY_MS,
    lastReviewedAt: now,
  };
}

/** Short human label for when a given answer would bring the card back — shown on the grade buttons. */
export function previewInterval(card: Flashcard, quality: number): string {
  const next = schedule(card, quality);
  if (quality < 3) return '10m';
  const days = next.interval;
  if (days < 1) return '10m';
  if (days === 1) return '1d';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

/** How overdue (or how far off) a card is, for display. */
export function describeDue(dueAt: number, now = Date.now()): string {
  const diff = dueAt - now;
  if (diff <= 0) return 'due now';
  const days = Math.round(diff / DAY_MS);
  if (days < 1) return `in ${Math.max(1, Math.round(diff / 60000))}m`;
  if (days === 1) return 'tomorrow';
  if (days < 30) return `in ${days}d`;
  return `in ${Math.round(days / 30)}mo`;
}
