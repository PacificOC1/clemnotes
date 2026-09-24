import { createPage, getAllPages } from './repository';
import { ensureFolderNamed } from './folderRepository';
import type { OutlinerNode } from './schema';

/**
 * Daily notes: one page per day, made the first time you open it.
 *
 * There was no obvious place for a thought that doesn't belong to a document
 * yet, so it went somewhere wrong or nowhere. A page per date is the standard
 * answer, and it gives every date a name you can link to.
 *
 * The page is titled with the ISO date — `2026-09-23` — rather than something
 * friendlier, for three reasons: it is what you would type inside `[[ ]]`,
 * it sorts, and it means the same thing in every locale. The friendly form is
 * shown above the title instead.
 *
 * A daily page is found by title, not by a fixed id. Ids are primary keys in
 * the shared Supabase table, so `daily-2026-09-23` would collide between two
 * people syncing to one project. The cost: two devices that both open "today"
 * while offline make two pages, and the older one is the one every later
 * lookup finds. Nothing is lost — both are ordinary pages — and it is rare.
 */

export const DAILY_FOLDER_NAME = 'Daily notes';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-09-23`, in local time — "today" means the day where you are. */
export function dailyTitle(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The date a title names, or null when it isn't one. Strict: `2026-02-30` is
 * not a date, and treating it as 2 March would make a link land somewhere
 * other than where it says.
 */
export function parseDailyTitle(title: string): Date | null {
  const match = ISO_DATE.exec(title.trim());
  if (!match) return null;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

/** The day `offset` days from `date`, keeping local midnight across DST changes. */
export function shiftDay(date: Date, offset: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
}

/** `Wednesday 23 September 2026` — shown above a daily page's title. */
export function describeDay(date: Date, today = new Date()): string {
  const full = date.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const diff = Math.round((shiftDay(date, 0).getTime() - shiftDay(today, 0).getTime()) / 86_400_000);
  if (diff === 0) return `Today · ${full}`;
  if (diff === -1) return `Yesterday · ${full}`;
  if (diff === 1) return `Tomorrow · ${full}`;
  return full;
}

/** The existing page for a date, if there is one — the oldest, if two devices each made one. */
export async function findDailyPage(date: Date): Promise<OutlinerNode | undefined> {
  const title = dailyTitle(date);
  return (await getAllPages())
    .filter((page) => page.plainText.trim() === title)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}

/**
 * The page for a date, made (and filed under "Daily notes") if it doesn't
 * exist yet. Returns its id.
 */
export async function openDailyNote(date: Date = new Date()): Promise<string> {
  const existing = await findDailyPage(date);
  if (existing) return existing.id;
  const folder = await ensureFolderNamed(DAILY_FOLDER_NAME);
  const page = await createPage(dailyTitle(date), folder.id);
  return page.id;
}

/**
 * Make the page a link points at, when it doesn't exist yet.
 *
 * A date goes through `openDailyNote`, so `[[2026-09-23]]` and the Today
 * button land on the same page — and the page is filed with the others —
 * rather than the link minting a second, unfiled page with the same title.
 */
export async function createPageForTitle(title: string): Promise<string> {
  const date = parseDailyTitle(title);
  if (date) return openDailyNote(date);
  return (await createPage(title)).id;
}

/**
 * `[[today`, `[[yesterday`, `[[tomorrow` — the words the link picker turns
 * into a date. Returns the date, or null for anything else.
 */
export function relativeDay(word: string, today = new Date()): Date | null {
  switch (word.trim().toLowerCase()) {
    case 'today':
      return shiftDay(today, 0);
    case 'yesterday':
      return shiftDay(today, -1);
    case 'tomorrow':
      return shiftDay(today, 1);
    default:
      return null;
  }
}
