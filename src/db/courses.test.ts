import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './database';
import { COURSES_FOLDER_NAME, addStudyNotes, addTextbookNotes, findCoursePage, getCourses, importStudyDesign, loadRoadmap } from './courseRepository';
import { parsePack, pointKey } from '../courses/notesPack';
import { parseTextbook } from '../courses/textbook';
import { undoLast } from './undo';

// The textbook the mock serves; a test can add a section to it to stand for a later pack.
const BOOK = {
  extra: '',
  text: () =>
    [
      '@chapter 2 | Fizz in practice',
      '@section 2.1 - | Overview',
      '**In a sentence**',
      '  Practice makes fizz.',
      '@chapter 1 | All about bubbles',
      '@section 1.2 U1.1.1.2 | Surface tension',
      'Tension :: skin',
      '@section 1.1 U1.1.1.1,U1.1.1.2 | Gases',
      '**Key ideas**',
      '  Warm water holds less gas.',
      'Warm water, gas? :: Less dissolves.',
      BOOK.extra,
    ].join('\n'),
};

// A small pack for the made-up design below; the real one is checked in notesPack.test.ts.
vi.mock('../courses/packs', () => ({
  hasPack: () => true,
  hasTextbook: () => true,
  loadTextbook: async () => parseTextbook(BOOK.text()).sort((a, b) => a.number - b.number),
  loadPack: async () =>
    parsePack(
      [
        `@ ${pointKey('the solubility of gases')} U1.1.1.1 | Gases`,
        '**Key ideas**',
        '  Gases dissolve less in warm water.',
        'Gas solubility as temperature rises? :: It falls.',
        `@ ${pointKey('surface tension')} U1.1.1.2 | Surface tension`,
        'Surface tension :: the skin on a liquid',
        `@ ${pointKey('reworded point')} U1.1.2.1 | Loose point, found by position`,
        'Loose :: point',
        `@ ${pointKey('pose a question')} S.1.1 | Skill`,
        'A good question is {{testable}}.',
      ].join('\n')
    ),
}));
import { buildReviewQueue, getScopeSummary } from './cardRepository';
import { getAllFolders } from './folderRepository';
import { createFirstChild, createPage, updateContent } from './repository';
import { buildTreeIndex, materialIds } from './cardScope';
import { catalogueSubject } from '../courses/catalogue';
import type { StudyDesign } from '../courses/studyDesign';
import { DEFAULT_SETTINGS } from '../srs/settings';
import { resetDatabase, textDoc } from '../test/helpers';
import type { DocNode } from '../tiptap/docUtils';

const CHEM = catalogueSubject('vce-chemistry')!;

const DESIGN: StudyDesign = {
  units: [
    {
      number: 1,
      title: 'Why do things fizz?',
      description: ['This unit is about fizz.', 'It has two areas.'],
      areas: [
        {
          number: 1,
          title: 'How do bubbles form?',
          description: ['In this area students blow bubbles.'],
          outcome: 'On completion of this unit the student should be able to explain bubbles.',
          groups: [
            { title: 'Gas and liquid', points: ['the solubility of gases', 'surface tension'] },
            { title: null, points: ['a loose point'] },
          ],
        },
        { number: 2, title: 'How is fizz measured?', description: ['Dropped: no outcome to sit before.'], outcome: null, groups: [{ title: 'Units', points: ['the units of fizz'] }] },
      ],
    },
    {
      number: 2,
      title: 'Where does the fizz go?',
      description: [],
      areas: [{ number: 1, title: 'Where does gas escape?', description: [], outcome: null, groups: [{ title: null, points: ['diffusion'] }] }],
    },
  ],
  skills: [{ title: 'Ask questions', points: ['pose a question'] }],
};

async function importChem(): Promise<string> {
  const { pageId, created } = await importStudyDesign(CHEM, DESIGN);
  expect(created).toBe(true);
  return pageId;
}

async function pointId(text: string): Promise<string> {
  const node = (await db.nodes.toArray()).find((n) => n.plainText === text);
  if (!node) throw new Error(`no rem "${text}"`);
  return node.id;
}

async function write(id: string, text: string): Promise<void> {
  await updateContent(id, textDoc(text), text);
}

function linkDoc(targetId: string, title: string, after: string): string {
  const doc: DocNode = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'wikiLink', attrs: { targetId, title } }, { type: 'text', text: after }],
      },
    ],
  };
  return JSON.stringify(doc);
}

describe('courses', () => {
  beforeEach(resetDatabase);

  it('imports a study design as a page in the Courses folder', async () => {
    const pageId = await importChem();
    const page = await db.nodes.get(pageId);
    expect(page).toMatchObject({ isPage: true, plainText: 'VCE Chemistry', parentId: null });

    const folders = await getAllFolders();
    expect(folders.find((f) => f.name === COURSES_FOLDER_NAME)?.pageIds).toEqual([pageId]);

    const courses = await getCourses();
    expect(courses).toEqual([{ pageId, title: 'VCE Chemistry', subject: CHEM }]);
    // No cards: nothing in a study design is a flashcard by itself.
    expect(await db.cards.count()).toBe(0);
  });

  it('opens the existing course instead of importing it twice', async () => {
    const first = await importChem();
    const again = await importStudyDesign(CHEM, DESIGN);
    expect(again).toEqual({ pageId: first, created: false });
    expect((await findCoursePage(CHEM))?.id).toBe(first);
  });

  it('reads the roadmap back from the page', async () => {
    const pageId = await importChem();
    const roadmap = (await loadRoadmap(pageId))!;
    expect(roadmap.title).toBe('VCE Chemistry');
    expect(roadmap.units.map((u) => [u.number, u.title, u.areas.length])).toEqual([
      [1, 'Why do things fizz?', 2],
      [2, 'Where does the fizz go?', 1],
    ]);
    expect(roadmap.units[0]!.description).toEqual(['This unit is about fizz.', 'It has two areas.']);
    const aos1 = roadmap.units[0]!.areas[0]!;
    expect(aos1.description).toEqual(['In this area students blow bubbles.']);
    // No outcome to sit before, so an introduction would read as dot points: it's left out.
    expect(roadmap.units[0]!.areas[1]!.description).toEqual([]);
    expect(aos1.outcome).toBe('On completion of this unit the student should be able to explain bubbles.');
    expect(aos1.groups.map((g) => [g.title, g.points.map((p) => p.text)])).toEqual([
      ['Gas and liquid', ['the solubility of gases', 'surface tension']],
      [null, ['a loose point']],
    ]);
    expect(roadmap.tally).toMatchObject({ points: 5, started: 0, cards: 0 });
    expect(roadmap.skills?.groups[0]?.points.map((p) => p.text)).toEqual(['pose a question']);
    expect(roadmap.next?.point.text).toBe('the solubility of gases');
  });

  it('counts notes written under a dot point, and moves "next up" on', async () => {
    const pageId = await importChem();
    const point = await pointId('the solubility of gases');
    const note = await createFirstChild(point);
    // A blank bullet isn't a note yet.
    expect((await loadRoadmap(pageId))!.tally.started).toBe(0);
    await write(note.id, 'gases dissolve less when warm');

    const roadmap = (await loadRoadmap(pageId))!;
    const p = roadmap.units[0]!.areas[0]!.groups[0]!.points[0]!;
    expect(p).toMatchObject({ status: 'notes', notes: 1, cards: 0 });
    expect(roadmap.tally.started).toBe(1);
    expect(roadmap.next?.point.text).toBe('surface tension');
  });

  it('counts flashcards under a dot point and in rems elsewhere that link to it', async () => {
    const pageId = await importChem();
    const point = await pointId('surface tension');
    const card = await createFirstChild(point);
    await write(card.id, 'Surface tension :: the skin on a liquid');

    const other = await createPage('Lecture notes');
    const linker = await createFirstChild(other.id);
    await updateContent(linker.id, linkDoc(point, 'surface tension', ' :: why water beads'), 'surface tension :: why water beads');

    const roadmap = (await loadRoadmap(pageId))!;
    const p = roadmap.units[0]!.areas[0]!.groups[0]!.points[1]!;
    expect(p).toMatchObject({ status: 'cards', notes: 2, cards: 2, due: 2 });
    expect(roadmap.units[0]!.areas[0]!.tally).toMatchObject({ started: 1, withCards: 1, cards: 2, due: 2 });
  });

  it('calls a dot point mastered once every card is out at three weeks', async () => {
    const pageId = await importChem();
    const point = await pointId('diffusion');
    const card = await createFirstChild(point);
    await write(card.id, 'Diffusion :: spreading out');
    await db.cards.toCollection().modify({ lastReviewedAt: Date.now(), intervalDays: 30, dueAt: Date.now() + 30 * 86_400_000 });

    const roadmap = (await loadRoadmap(pageId))!;
    expect(roadmap.units[1]!.areas[0]!.groups[0]!.points[0]!.status).toBe('mastered');
    expect(roadmap.tally.mastered).toBe(1);
  });

  it('picks up dot points added or reworded by hand', async () => {
    const pageId = await importChem();
    const point = await pointId('the units of fizz');
    await write(point, 'the units of fizz, reworded');
    const roadmap = (await loadRoadmap(pageId))!;
    expect(roadmap.units[0]!.areas[1]!.groups[0]!.points[0]!.text).toBe('the units of fizz, reworded');
  });

  it('reviews one area of study: its dot points and what links to them', async () => {
    const pageId = await importChem();
    const inArea = await createFirstChild(await pointId('a loose point'));
    await write(inArea.id, 'Loose :: point');
    const elsewhere = await createFirstChild(await pointId('diffusion'));
    await write(elsewhere.id, 'Diffusion :: spreading out');

    const roadmap = (await loadRoadmap(pageId))!;
    const areaId = roadmap.units[0]!.areas[0]!.id;
    const plan = await buildReviewQueue(DEFAULT_SETTINGS, Date.now() + 1000, areaId);
    expect(plan.queue.map((c) => c.nodeId)).toEqual([inArea.id]);
    expect(await getScopeSummary(areaId)).toMatchObject({ isPage: false, due: 1, total: 1 });

    // The whole course is still a page scope.
    const all = await buildReviewQueue(DEFAULT_SETTINGS, Date.now() + 1000, pageId);
    expect(all.queue).toHaveLength(2);
  });
});

describe('study notes', () => {
  beforeEach(resetDatabase);

  it('files each entry under its dot point, folds it, and leaves your own notes alone', async () => {
    const pageId = await importChem();
    const mine = await createFirstChild(await pointId('surface tension'));
    await write(mine.id, 'my own note');

    const result = await addStudyNotes(pageId, CHEM);
    // gases (by wording), a loose point (by position), the skill; surface tension had notes.
    expect(result).toEqual({ added: 3, skipped: 1, unmatched: 0, rems: 5 });

    const gases = await pointId('the solubility of gases');
    expect((await db.nodes.get(gases))?.collapsed).toBe(true);
    const roadmap = (await loadRoadmap(pageId))!;
    const [p1, p2] = roadmap.units[0]!.areas[0]!.groups[0]!.points;
    expect(p1).toMatchObject({ status: 'cards', notes: 3, cards: 1, fresh: 1 });
    expect(p2).toMatchObject({ status: 'notes', cards: 0 });
    expect(roadmap.skills?.groups[0]?.points[0]).toMatchObject({ status: 'cards', cards: 1 });
    // Ready-made notes aren't "studied" until their cards have been reviewed; your own notes are.
    expect(roadmap.tally.studied).toBe(1);
    expect(roadmap.next?.point.id).toBe(gases);

    // Pressing it again adds nothing.
    expect(await addStudyNotes(pageId, CHEM)).toMatchObject({ added: 0, skipped: 4 });
  });

  it('is one undo', async () => {
    const pageId = await importChem();
    await addStudyNotes(pageId, CHEM);
    await undoLast();
    expect((await loadRoadmap(pageId))!.tally.withCards).toBe(0);
  });

  it('counts a dot point studied once every card has been reviewed', async () => {
    const pageId = await importChem();
    await addStudyNotes(pageId, CHEM);
    await db.cards.toCollection().modify({ lastReviewedAt: Date.now(), intervalDays: 3, dueAt: Date.now() + 3 * 86_400_000 });
    const roadmap = (await loadRoadmap(pageId))!;
    expect(roadmap.units[0]!.areas[0]!.groups[0]!.points[0]!.status).toBe('learning');
    expect(roadmap.tally.studied).toBe(3);
  });
});

describe('loadLesson', () => {
  beforeEach(resetDatabase);

  it('returns the notes under a learning point as a tree, and what links to it', async () => {
    const { loadLesson } = await import('./courseRepository');
    const pageId = await importChem();
    await addStudyNotes(pageId, CHEM);
    const point = await pointId('the solubility of gases');
    const other = await createPage('Lecture notes');
    const linker = await createFirstChild(other.id);
    await updateContent(linker.id, linkDoc(point, 'gases', ' dissolve less when warm'), 'gases dissolve less when warm');

    const lesson = (await loadLesson(point))!;
    expect(lesson.body.map((r) => r.node.plainText)).toEqual(['Key ideas', 'Gas solubility as temperature rises? :: It falls.']);
    expect(lesson.body[0]!.children.map((r) => r.node.plainText)).toEqual(['Gases dissolve less in warm water.']);
    expect(lesson.linked.map((n) => n.id)).toEqual([linker.id]);
    expect(await loadLesson('nope')).toBeNull();
  });
});

describe('materialIds', () => {
  beforeEach(resetDatabase);

  it('is a rem, everything under it, and whatever links into that', async () => {
    const page = await createPage('P');
    const a = await createFirstChild(page.id);
    const b = await createFirstChild(a.id);
    const other = await createPage('Q');
    const c = await createFirstChild(other.id);
    await updateContent(c.id, linkDoc(b.id, 'b', ''), 'b');
    await db.nodes.update(b.id, { plainText: 'b' });

    const ids = materialIds(a.id, buildTreeIndex(await db.nodes.toArray()));
    expect([...ids].sort()).toEqual([a.id, b.id, c.id].sort());
  });
});

describe('textbook notes', () => {
  beforeEach(async () => {
    await resetDatabase();
    BOOK.extra = '';
  });
  const ECON = catalogueSubject('vce-economics')!;

  it('files chapters and sections under a Textbook heading, in the book\'s order', async () => {
    const { pageId } = await importStudyDesign(ECON, DESIGN);
    const before = (await loadRoadmap(pageId))!;
    expect(before.textbook).toBeNull();

    const result = await addTextbookNotes(pageId, ECON);
    expect(result).toMatchObject({ added: 3, skipped: 0 });

    const roadmap = (await loadRoadmap(pageId))!;
    const book = roadmap.textbook!;
    expect(book.title).toBe(ECON.textbook!.title);
    expect(book.chapters.map((c) => [c.number, c.title, c.sections.map((s) => `${s.number} ${s.title}`)])).toEqual([
      [1, 'All about bubbles', ['1.1 Gases', '1.2 Surface tension']],
      [2, 'Fizz in practice', ['2.1 Overview']],
    ]);
    // A section is a lesson: its notes and cards count for it, not for the study design.
    expect(book.chapters[0]!.sections.find((s) => s.number === '1.1')).toMatchObject({ status: 'cards', cards: 1 });
    expect(book.tally).toMatchObject({ points: 3, cards: 2 });
    expect(roadmap.tally).toMatchObject({ points: 5, cards: 0 });
    expect(roadmap.units).toHaveLength(2);

    // The headings read as the book does.
    const page = (await db.nodes.toArray()).filter((n) => n.parentId === book.chapters[0]!.id).map((n) => n.plainText);
    expect(page.sort()).toEqual(['Chapter 1.1 Gases', 'Chapter 1.2 Surface tension']);
  });

  it('adds only what is missing the second time, and is one undo', async () => {
    const { pageId } = await importStudyDesign(ECON, DESIGN);
    await addTextbookNotes(pageId, ECON);
    const count = await db.nodes.count();
    expect(await addTextbookNotes(pageId, ECON)).toMatchObject({ added: 0, skipped: 3, rems: 0 });
    expect(await db.nodes.count()).toBe(count);

    BOOK.extra = ['@chapter 3 | Later', '@section 3.1 - | New', '**In a sentence**', '  Added later.'].join('\n');
    expect(await addTextbookNotes(pageId, ECON)).toMatchObject({ added: 1, skipped: 3 });
    expect((await loadRoadmap(pageId))!.textbook!.chapters.map((c) => c.number)).toEqual([1, 2, 3]);

    await undoLast();
    expect((await loadRoadmap(pageId))!.textbook!.chapters.map((c) => c.number)).toEqual([1, 2]);
  });

  it('refuses a subject without a textbook', async () => {
    const pageId = await importChem();
    await expect(addTextbookNotes(pageId, CHEM)).rejects.toThrow(/no textbook/);
  });
});
