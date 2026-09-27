import { beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { readApkg } from './anki';
import { fieldToInline } from './ankiHtml';
import { importAnkiCollection, qualityForEase } from './importAnki';
import { resetDatabase } from '../test/helpers';
import { getAllPages, getChildren } from '../db/repository';
import { getCardsForNode } from '../db/cardRepository';
import { getReviewsForCard } from '../db/reviewRepository';
import { getImage } from '../db/imageRepository';
import { db } from '../db/database';
import { docToPlainText, extractTags, parseDoc } from '../tiptap/docUtils';
import { historySince, replay } from '../srs/fsrs';

/**
 * Real packages made by Anki itself (see fixtures/make-fixtures.py), in both
 * the current format and the "support older versions" one.
 */

import modern from './fixtures/biology-modern.apkg?inline';
import legacy from './fixtures/biology-legacy.apkg?inline';

let SQL: SqlJsStatic;
const FIXTURES: Record<string, string> = { 'biology-modern.apkg': modern, 'biology-legacy.apkg': legacy };
/** `?inline` hands the file over as a data URL, which works under both Vite and tsc. */
const fixture = (name: string) => Uint8Array.from(atob(FIXTURES[name]!.split(',')[1]!), (c) => c.charCodeAt(0));

beforeEach(async () => {
  SQL ??= await initSqlJs();
  await resetDatabase();
});

describe('Anki field HTML', () => {
  it('keeps formatting, breaks, entities and maths', () => {
    const { inline } = fieldToInline('What is the <b>powerhouse</b>&nbsp;of the cell?<br>Two \\(H_2O\\)');
    expect(inline.find((n) => n.text === 'powerhouse')?.marks).toEqual([{ type: 'bold' }]);
    expect(inline.some((n) => n.type === 'hardBreak')).toBe(true);
    expect(inline.find((n) => n.type === 'math')?.attrs).toEqual({ latex: 'H_2O' });
    expect(docToPlainText({ type: 'doc', content: [{ type: 'paragraph', content: inline }] })).toBe(
      'What is the powerhouse of the cell?Two H_2O'
    );
  });

  it('turns cloze deletions into numbered blanks, hints and formatting dropped', () => {
    const { inline } = fieldToInline('The {{c1::<i>nucleus</i>}} holds {{c2::DNA::genetic material}}.');
    expect(inline.filter((n) => n.type === 'cloze').map((n) => n.attrs)).toEqual([
      { index: 1, text: 'nucleus' },
      { index: 2, text: 'DNA' },
    ]);
  });

  it('lifts images out and drops sound tags', () => {
    const { inline, images } = fieldToInline('Makes proteins<br><img src="cell.png"> [sound:x.mp3]');
    expect(images).toEqual(['cell.png']);
    expect(inline.map((n) => n.text ?? n.type).join('')).toBe('Makes proteins');
  });

  it('maps the four buttons', () => {
    expect([1, 2, 3, 4].map(qualityForEase)).toEqual([0, 3, 4, 5]);
  });
});

describe.each([
  ['current format', 'biology-modern.apkg'],
  ['older format', 'biology-legacy.apkg'],
])('reading a package (%s)', (_label, file) => {
  it('reads decks, note types, notes, cards, reviews and media', () => {
    const col = readApkg(fixture(file), SQL);
    expect([...col.decks.values()].map((p) => p.join('/')).sort()).toEqual(['Biology', 'Biology/Cells', 'Default']);
    expect(col.notes).toHaveLength(4);
    expect(col.cards).toHaveLength(6);
    expect(col.reviews).toHaveLength(6);
    expect([...col.noteTypes.values()].filter((t) => t.isCloze).map((t) => t.name)).toEqual(['Cloze']);
    expect([...col.media.keys()]).toEqual(['cell.png']);
    expect(col.media.get('cell.png')?.[1]).toBe(0x50); // "PNG"
  });

  it('imports it with schedules, history, tags and the image', async () => {
    const report = await importAnkiCollection(readApkg(fixture(file), SQL));
    expect(report).toMatchObject({ decks: 1, notes: 4, cards: 6, reviews: 6, images: 1, skippedNotes: 0 });

    const pages = await getAllPages();
    const biology = pages.find((p) => p.plainText === 'Biology')!;
    expect(pages.map((p) => p.plainText).sort()).toEqual(['Biology', 'cells', 'exam']);

    const top = await getChildren(biology.id);
    const texts = top.map((r) => r.plainText);
    expect(texts).toContain('What is the powerhouse of the cell? :: The mitochondria');
    expect(texts).toContain('Water formula :: H_2O');
    const cellsHeading = top.find((r) => r.plainText === 'Cells')!;
    const cellNotes = await getChildren(cellsHeading.id);
    const ribosome = cellNotes.find((r) => r.plainText.startsWith('Ribosome'))!;
    const cloze = cellNotes.find((r) => r.plainText.startsWith('The nucleus'))!;

    // Reversed note: both directions; cloze note: one card per blank.
    expect((await getCardsForNode(ribosome.id)).map((c) => c.kind).sort()).toEqual(['backward', 'forward']);
    expect((await getCardsForNode(cloze.id)).map((c) => c.clozeIndex).sort()).toEqual([1, 2]);

    // The image made it into IndexedDB and into the rem.
    const imageBlock = parseDoc(ribosome.content).content?.find((b) => b.type === 'remImage');
    expect(await getImage(String(imageBlock?.attrs?.imageId))).toBeDefined();

    // Tags and extra fields become children.
    const clozeChildren = await getChildren(cloze.id);
    expect(clozeChildren.map((c) => c.plainText)).toEqual(['Back Extra: Extra info', '#cells #exam']);
    expect(extractTags(parseDoc(clozeChildren[1]!.content)).every((t) => t.targetId !== null || t.title)).toBe(true);

    // Scheduling carried over: the reviewed Basic card is a review card with
    // Anki's interval; the suspended one is suspended.
    const [powerhouse] = await getCardsForNode(top.find((r) => r.plainText.startsWith('What is'))!.id);
    expect(powerhouse!.intervalDays).toBe(5);
    expect(powerhouse!.lastReviewedAt).not.toBeNull();
    const [water] = await getCardsForNode(top.find((r) => r.plainText.startsWith('Water'))!.id);
    expect(water!.suspended).toBe(true);

    // And the history is there for FSRS to replay.
    const history = await getReviewsForCard(powerhouse!.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.grade).toBe(5);
    expect(replay(historySince(powerhouse!, history)).state).not.toBeNull();
    expect(await db.reviews.count()).toBe(6);
  });
});

describe('bad input', () => {
  it('says so when the file is not a zip', () => {
    expect(() => readApkg(new Uint8Array([1, 2, 3]), SQL)).toThrow(/couldn't be unzipped/);
  });
});
