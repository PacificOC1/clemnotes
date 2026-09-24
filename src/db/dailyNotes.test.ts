import { beforeEach, describe, expect, it } from 'vitest';
import {
  DAILY_FOLDER_NAME,
  createPageForTitle,
  dailyTitle,
  describeDay,
  findDailyPage,
  openDailyNote,
  parseDailyTitle,
  relativeDay,
  shiftDay,
} from './dailyNotes';
import { getAllFolders } from './folderRepository';
import { createPage, getAllPages, getNode } from './repository';
import { resetDatabase } from '../test/helpers';

beforeEach(resetDatabase);

const SEPT_23 = new Date(2026, 8, 23, 15, 30);

describe('dates as titles', () => {
  it('writes the local date, zero-padded', () => {
    expect(dailyTitle(SEPT_23)).toBe('2026-09-23');
    expect(dailyTitle(new Date(2027, 0, 5))).toBe('2027-01-05');
  });

  it('reads back only real dates', () => {
    expect(dailyTitle(parseDailyTitle('2026-09-23')!)).toBe('2026-09-23');
    expect(parseDailyTitle(' 2026-09-23 ')).not.toBeNull();
    expect(parseDailyTitle('2026-02-30')).toBeNull();
    expect(parseDailyTitle('2026-9-23')).toBeNull();
    expect(parseDailyTitle('Notes from 2026-09-23')).toBeNull();
  });

  it('steps across a month and a year', () => {
    expect(dailyTitle(shiftDay(new Date(2026, 11, 31), 1))).toBe('2027-01-01');
    expect(dailyTitle(shiftDay(new Date(2026, 2, 1), -1))).toBe('2026-02-28');
  });

  it('names today, yesterday and tomorrow', () => {
    expect(describeDay(SEPT_23, SEPT_23)).toMatch(/^Today · /);
    expect(describeDay(shiftDay(SEPT_23, -1), SEPT_23)).toMatch(/^Yesterday · /);
    expect(describeDay(shiftDay(SEPT_23, 1), SEPT_23)).toMatch(/^Tomorrow · /);
    expect(describeDay(shiftDay(SEPT_23, 5), SEPT_23)).not.toMatch(/·/);
  });

  it('understands the words the link picker offers', () => {
    expect(dailyTitle(relativeDay('Yesterday', SEPT_23)!)).toBe('2026-09-22');
    expect(relativeDay('someday', SEPT_23)).toBeNull();
  });
});

describe('opening a daily note', () => {
  it('makes the page once, filed under Daily notes', async () => {
    const first = await openDailyNote(SEPT_23);
    const again = await openDailyNote(new Date(2026, 8, 23, 23, 59));
    expect(again).toBe(first);

    const page = await getNode(first);
    expect(page?.plainText).toBe('2026-09-23');
    expect(page?.isPage).toBe(true);

    const folders = await getAllFolders();
    expect(folders.map((f) => f.name)).toEqual([DAILY_FOLDER_NAME]);
    expect(folders[0]?.pageIds).toEqual([first]);
  });

  it('reuses the one folder for every day', async () => {
    await openDailyNote(SEPT_23);
    await openDailyNote(shiftDay(SEPT_23, 1));
    const folders = await getAllFolders();
    expect(folders).toHaveLength(1);
    expect(folders[0]?.pageIds).toHaveLength(2);
  });

  it('finds the older page when two devices each made one', async () => {
    const id = await openDailyNote(SEPT_23);
    // A second page with the same title, as a sync from another device would leave.
    await createPage('2026-09-23');
    expect((await findDailyPage(SEPT_23))?.id).toBe(id);
  });

  it('a link to a date opens the daily note rather than making a loose page', async () => {
    const viaLink = await createPageForTitle('2026-09-23');
    expect(await openDailyNote(SEPT_23)).toBe(viaLink);
    expect((await getAllPages()).filter((p) => p.plainText === '2026-09-23')).toHaveLength(1);
  });

  it('a link to anything else still makes an ordinary page', async () => {
    const id = await createPageForTitle('Photosynthesis');
    expect((await getNode(id))?.plainText).toBe('Photosynthesis');
    expect(await getAllFolders()).toEqual([]);
  });
});
