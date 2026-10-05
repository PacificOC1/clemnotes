import type { DraftRem } from '../db/treeInsert';
import type { DocNode } from '../tiptap/docUtils';
import { parseOutline } from './notesPack';

/**
 * Study notes that follow a textbook's chapters rather than the study design's
 * dot points. They live in the course page under one heading, so they sync,
 * search and make cards like any other rems:
 *
 *     VCE Economics                                         (the course page)
 *       ## Unit 1: …                                        (the study design, as before)
 *       ## Textbook: Jacaranda Key Concepts in VCE …         ← TEXTBOOK_PREFIX + the book
 *         ### Chapter 6: The economics of international trade
 *           #### Chapter 6.1 Overview                        ← a section = a lesson
 *             **In a sentence** …                            (the notes, as in a pack)
 *
 * ## The textbook pack format
 *
 *     @chapter 6 | The economics of international trade
 *     @section 6.2 U2.2.1.1 | Definition, nature and direction of international trade
 *     **In a sentence**                                      ← body lines exactly as in a study-notes pack
 *       …
 *     @section 6.1 - | Overview                              ← "-": covers no dot point
 *     @section 6.8 U2.2.1.1,U2.2.1.5 | Review                ← several, comma-separated
 *
 * A section names the study-design positions it covers (the book's own "what
 * you will learn" table), so a lesson can point to the learning points and a
 * learning point to the textbook sections. Positions only — the hash keys of
 * `notesPack.ts` aren't needed because nothing is filed under the dot points.
 * As with every pack: our own words, never the book's text.
 */

export const TEXTBOOK_PREFIX = 'Textbook: ';

export interface TextbookSectionEntry {
  /** "6.2" */
  number: string;
  title: string;
  /** Study-design positions, "U2.2.1.1". */
  covers: string[];
  drafts: DraftRem[];
}

export interface TextbookChapterEntry {
  number: number;
  title: string;
  sections: TextbookSectionEntry[];
}

const CHAPTER = /^@chapter\s+(\d+)\s*\|\s*(.+)$/;
const SECTION = /^@section\s+(\d+\.\d+)\s+(-|U\d+\.\d+\.\d+\.\d+(?:,U\d+\.\d+\.\d+\.\d+)*)\s*\|\s*(.+)$/;

export function parseTextbook(source: string): TextbookChapterEntry[] {
  const chapters: TextbookChapterEntry[] = [];
  // A chapter line has no body of its own: lines between it and its first section land here.
  const stray: DraftRem[] = [];
  parseOutline(source, (line, lineNumber) => {
    const chapter = CHAPTER.exec(line);
    if (chapter) {
      chapters.push({ number: Number(chapter[1]), title: chapter[2]!.trim(), sections: [] });
      return stray;
    }
    const section = SECTION.exec(line);
    if (!section) throw new Error(`Textbook line ${lineNumber}: not a "@chapter" or "@section" line.`);
    const current = chapters[chapters.length - 1];
    if (!current) throw new Error(`Textbook line ${lineNumber}: a section before any "@chapter".`);
    if (!section[1]!.startsWith(`${current.number}.`)) {
      throw new Error(`Textbook line ${lineNumber}: section ${section[1]} isn't in chapter ${current.number}.`);
    }
    const entry: TextbookSectionEntry = {
      number: section[1]!,
      title: section[3]!.trim(),
      covers: section[2] === '-' ? [] : section[2]!.split(','),
      drafts: [],
    };
    current.sections.push(entry);
    return entry.drafts;
  });
  if (stray.length > 0) throw new Error('Textbook: text between a "@chapter" line and its first "@section".');
  return chapters;
}

// ---------------------------------------------------------------------------
// Titles, both ways
// ---------------------------------------------------------------------------

export const chapterHeading = (c: { number: number; title: string }) => `Chapter ${c.number}: ${c.title}`;
export const sectionHeading = (s: { number: string; title: string }) => `Chapter ${s.number} ${s.title}`;

const CHAPTER_TEXT = /^Chapter\s+(\d+)\s*[:.–—-]?\s*(.*)$/i;
const SECTION_TEXT = /^Chapter\s+(\d+\.\d+)\s*[:.–—-]?\s*(.*)$/i;

export function readChapterHeading(text: string): { number: number; title: string } | null {
  if (SECTION_TEXT.test(text)) return null;
  const m = CHAPTER_TEXT.exec(text.trim());
  return m ? { number: Number(m[1]), title: m[2]!.trim() } : null;
}

export function readSectionHeading(text: string): { number: string; title: string } | null {
  const m = SECTION_TEXT.exec(text.trim());
  return m ? { number: m[1]!, title: m[2]!.trim() } : null;
}

/** "6.10" sorts after "6.9". */
export function compareSectionNumbers(a: string, b: string): number {
  const [a1, a2] = a.split('.').map(Number);
  const [b1, b2] = b.split('.').map(Number);
  return a1! - b1! || a2! - b2!;
}

// ---------------------------------------------------------------------------
// Entries → rems
// ---------------------------------------------------------------------------

function heading(level: number, text: string): DocNode {
  return { type: 'doc', content: [{ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] }] };
}

export function sectionDraft(section: TextbookSectionEntry): DraftRem {
  return { doc: heading(4, sectionHeading(section)), children: section.drafts, collapsed: true };
}

export function chapterDraft(chapter: TextbookChapterEntry, sections = chapter.sections): DraftRem {
  return { doc: heading(3, chapterHeading(chapter)), children: sections.map(sectionDraft) };
}

export function textbookDraft(bookTitle: string, chapters: TextbookChapterEntry[]): DraftRem {
  return { doc: heading(2, `${TEXTBOOK_PREFIX}${bookTitle}`), collapsed: true, children: chapters.map((c) => chapterDraft(c)) };
}
