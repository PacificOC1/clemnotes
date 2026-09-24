import { dailyTitle, describeDay, openDailyNote, parseDailyTitle, shiftDay } from '../db/dailyNotes';

interface Props {
  /** The title of the page on screen — only a date-titled page gets the bar. */
  title: string;
  onOpen: (pageId: string) => void;
}

/**
 * Above a daily page: which day it is in words, and a step either side.
 *
 * Stepping makes the neighbouring day's page if it doesn't exist yet, the same
 * as following a link to it would — a day you haven't written in is still a
 * day you can open.
 */
export function DailyNav({ title, onOpen }: Props) {
  const date = parseDailyTitle(title);
  if (!date) return null;

  const go = (target: Date) => void openDailyNote(target).then(onOpen);
  const isToday = dailyTitle(date) === dailyTitle(new Date());

  return (
    <nav className="daily-nav" aria-label="Daily notes">
      <button type="button" className="daily-step" onClick={() => go(shiftDay(date, -1))} title={dailyTitle(shiftDay(date, -1))}>
        ‹
      </button>
      <span className="daily-label">{describeDay(date)}</span>
      <button type="button" className="daily-step" onClick={() => go(shiftDay(date, 1))} title={dailyTitle(shiftDay(date, 1))}>
        ›
      </button>
      {!isToday && (
        <button type="button" className="daily-today" onClick={() => go(new Date())}>
          Today
        </button>
      )}
    </nav>
  );
}
