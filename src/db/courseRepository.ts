import { db } from './database';
import { getAllPages, getBacklinks } from './repository';
import { ensureFolderNamed, getAllFolders } from './folderRepository';
import { createPageWithTree, insertTreesUnder, type DraftRem } from './treeInsert';
import { buildTreeIndex } from './cardScope';
import type { OutlinerNode } from './schema';
import { CATALOGUE, unitsLabel, type CatalogueSubject } from '../courses/catalogue';
import { designToDrafts, readRoadmap, type Roadmap } from '../courses/courseTree';
import { planPack } from '../courses/notesPack';
import { loadPack, loadTextbook } from '../courses/packs';
import { chapterDraft, sectionDraft, textbookDraft } from '../courses/textbook';
import type { StudyDesign } from '../courses/studyDesign';
import { docFromText } from '../tiptap/docUtils';

/**
 * Courses are pages filed in a "Courses" folder (found by name, like "Tags"
 * and "Daily notes" — never a fixed id, which would collide in Supabase), or
 * pages titled like a catalogue subject wherever they've been moved to.
 */
export const COURSES_FOLDER_NAME = 'Courses';

export interface CourseSummary {
  pageId: string;
  title: string;
  /** The catalogue entry it was imported from, when it matches one. */
  subject: CatalogueSubject | null;
}

function titleOf(page: OutlinerNode): string {
  return page.plainText.trim();
}

/** The course page for a subject — the oldest, if two devices each made one. */
export async function findCoursePage(subject: CatalogueSubject): Promise<OutlinerNode | undefined> {
  const pages = await getAllPages();
  return pages
    .filter((p) => titleOf(p).toLowerCase() === subject.title.toLowerCase())
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}

export async function getCourses(): Promise<CourseSummary[]> {
  const [pages, folders] = await Promise.all([getAllPages(), getAllFolders()]);
  const inFolder = new Set(
    folders.filter((f) => f.name.trim().toLowerCase() === COURSES_FOLDER_NAME.toLowerCase()).flatMap((f) => f.pageIds)
  );
  const bySubject = new Map<string, OutlinerNode>();
  for (const page of [...pages].sort((a, b) => a.createdAt - b.createdAt)) {
    const subject = CATALOGUE.find((s) => s.title.toLowerCase() === titleOf(page).toLowerCase());
    if (subject && !bySubject.has(subject.id)) bySubject.set(subject.id, page);
  }
  const out: CourseSummary[] = [];
  const seen = new Set<string>();
  for (const [subjectId, page] of bySubject) {
    out.push({ pageId: page.id, title: titleOf(page), subject: CATALOGUE.find((s) => s.id === subjectId) ?? null });
    seen.add(page.id);
  }
  for (const page of pages) {
    if (inFolder.has(page.id) && !seen.has(page.id)) {
      out.push({ pageId: page.id, title: titleOf(page) || 'Untitled', subject: null });
    }
  }
  return out;
}

export function courseIntro(subject: CatalogueSubject): string {
  return (
    `Key knowledge from the VCAA ${subject.title.replace(/^VCE\s+/i, '')} study design (${subject.accredited}), ` +
    `${unitsLabel(subject.units)}. Write notes under a dot point, or link to one from anywhere — ` +
    `the Courses tab tracks what you've covered.`
  );
}

/**
 * Make the course page from a parsed study design. Returns the existing page
 * instead when the subject is already imported, so a second import can't
 * leave two copies with the notes split between them.
 */
export async function importStudyDesign(
  subject: CatalogueSubject,
  design: StudyDesign
): Promise<{ pageId: string; created: boolean }> {
  const existing = await findCoursePage(subject);
  if (existing) return { pageId: existing.id, created: false };
  const folder = await ensureFolderNamed(COURSES_FOLDER_NAME);
  const pageId = await createPageWithTree(docFromText(subject.title), designToDrafts(design, courseIntro(subject)), folder.id);
  return { pageId, created: true };
}

/** Everything the roadmap screen shows, in one read of nodes and cards. */
export async function loadRoadmap(pageId: string, now = Date.now()): Promise<Roadmap | null> {
  const [nodes, cards] = await Promise.all([db.nodes.toArray(), db.cards.toArray()]);
  return readRoadmap(pageId, nodes, cards, now, buildTreeIndex(nodes));
}

export interface StudyNotesResult {
  /** Dot points that got notes. */
  added: number;
  /** Dot points that already had notes of yours, left as they were. */
  skipped: number;
  /** Notes whose dot point isn't in this course. */
  unmatched: number;
  /** Rems created. */
  rems: number;
}

/**
 * File the subject's ready-made study notes under each dot point of a course
 * page. A dot point you've already written under is left alone, so pressing
 * it twice adds nothing the second time. Each filled dot point is folded, so
 * the course page still reads as an outline. One undo.
 */
export async function addStudyNotes(pageId: string, subject: CatalogueSubject): Promise<StudyNotesResult> {
  const entries = await loadPack(subject.id);
  const [nodes, cards] = await Promise.all([db.nodes.toArray(), db.cards.toArray()]);
  const index = buildTreeIndex(nodes);
  const roadmap = readRoadmap(pageId, nodes, cards, Date.now(), index);
  if (!roadmap) throw new Error("That course isn't in your notes any more.");

  const hasOwnNotes = (pointId: string) =>
    (index.children.get(pointId) ?? []).some((child) => child.plainText.trim() !== '' || child.isPortal);
  const plan = planPack(entries, roadmap, hasOwnNotes);

  const ids = await insertTreesUnder(
    plan.place.map(({ pointId, entry }) => ({ parentId: pointId, drafts: entry.drafts })),
    'Add study notes'
  );
  // Folding is view state, not an edit: no updatedAt.
  await db.transaction('rw', db.nodes, async () => {
    for (const { pointId } of plan.place) await db.nodes.update(pointId, { collapsed: true });
  });

  return { added: plan.place.length, skipped: plan.skipped, unmatched: plan.unmatched.length, rems: ids.length };
}

export interface TextbookNotesResult {
  /** Sections that got notes. */
  added: number;
  /** Sections already in the course (yours or added before), left as they were. */
  skipped: number;
  rems: number;
}

/**
 * File the subject's textbook notes in the course page, under a
 * "Textbook: <book>" heading, one heading per chapter and one lesson per
 * section. Chapters and sections already there are left alone, so pressing it
 * again only adds what's new (a chapter added to the pack later). One undo.
 */
export async function addTextbookNotes(pageId: string, subject: CatalogueSubject): Promise<TextbookNotesResult> {
  if (!subject.textbook) throw new Error(`${subject.title} has no textbook notes.`);
  const chapters = await loadTextbook(subject.id);
  const [nodes, cards] = await Promise.all([db.nodes.toArray(), db.cards.toArray()]);
  const roadmap = readRoadmap(pageId, nodes, cards, Date.now(), buildTreeIndex(nodes));
  if (!roadmap) throw new Error("That course isn't in your notes any more.");

  const all = chapters.reduce((n, c) => n + c.sections.length, 0);
  const items: Array<{ parentId: string; drafts: DraftRem[] }> = [];
  let added = 0;
  if (!roadmap.textbook) {
    items.push({ parentId: pageId, drafts: [textbookDraft(subject.textbook.title, chapters)] });
    added = all;
  } else {
    const book = roadmap.textbook;
    for (const chapter of chapters) {
      const there = book.chapters.find((c) => c.number === chapter.number);
      if (!there) {
        items.push({ parentId: book.id, drafts: [chapterDraft(chapter)] });
        added += chapter.sections.length;
        continue;
      }
      const missing = chapter.sections.filter((s) => !there.sections.some((t) => t.number === s.number));
      if (missing.length > 0) items.push({ parentId: there.id, drafts: missing.map(sectionDraft) });
      added += missing.length;
    }
  }
  const ids = await insertTreesUnder(items, 'Add textbook notes');
  return { added, skipped: all - added, rems: ids.length };
}

export interface LessonRem {
  node: OutlinerNode;
  children: LessonRem[];
}

export interface Lesson {
  point: OutlinerNode;
  /** Everything written under the learning point, as a tree. */
  body: LessonRem[];
  /** Rems elsewhere that link to (or tag) the learning point. */
  linked: OutlinerNode[];
}

async function lessonChildren(parentId: string, depth: number): Promise<LessonRem[]> {
  if (depth > 12) return []; // a guard against a corrupt cycle, far deeper than any real note
  const rows = (await db.nodes.where('parentId').equals(parentId).toArray())
    .filter((n) => n.deletedAt === null)
    .sort((a, b) => a.order - b.order);
  return Promise.all(rows.map(async (node) => ({ node, children: await lessonChildren(node.id, depth + 1) })));
}

/** A learning point and its notes, for the lesson view. */
export async function loadLesson(pointId: string): Promise<Lesson | null> {
  const point = await db.nodes.get(pointId);
  if (!point || point.deletedAt !== null) return null;
  const [body, linked] = await Promise.all([lessonChildren(pointId, 0), getBacklinks(pointId)]);
  return { point, body, linked: linked.filter((n) => n.deletedAt === null) };
}
