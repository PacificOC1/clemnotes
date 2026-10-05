import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { compareSectionNumbers, parseTextbook, readChapterHeading, readSectionHeading, sectionHeading } from './textbook';
import { loadTextbook } from './packs';
import { CATALOGUE } from './catalogue';
import { CARD_SEPARATOR, extractClozeIndices, splitOnSeparator, type DocNode } from '../tiptap/docUtils';
import type { DraftRem } from '../db/treeInsert';

describe('parseTextbook', () => {
  const source = [
    '% a comment',
    '@chapter 6 | Trade',
    '@section 6.1 - | Overview',
    '**In a sentence**',
    '  Countries trade.',
    '@section 6.2 U2.2.1.1,U2.2.1.3 | Definition',
    'Exports :: goods sold abroad',
  ].join('\n');

  it('reads chapters, sections, what each covers, and the notes', () => {
    const [chapter] = parseTextbook(source);
    expect(chapter).toMatchObject({ number: 6, title: 'Trade' });
    expect(chapter!.sections.map((s) => [s.number, s.title, s.covers])).toEqual([
      ['6.1', 'Overview', []],
      ['6.2', 'Definition', ['U2.2.1.1', 'U2.2.1.3']],
    ]);
    expect(chapter!.sections[0]!.drafts[0]!.children).toHaveLength(1);
  });

  it('refuses sections outside their chapter, stray text and unknown @ lines', () => {
    expect(() => parseTextbook('@chapter 6 | T\n@section 7.1 - | X')).toThrow(/isn't in chapter 6/);
    expect(() => parseTextbook('@section 6.1 - | X')).toThrow(/before any/);
    expect(() => parseTextbook('@chapter 6 | T\nloose text')).toThrow(/between a "@chapter"/);
    expect(() => parseTextbook('@chapter 6 | T\n@sektion 6.1 - | X')).toThrow(/not a "@chapter" or "@section"/);
  });

  it('reads its own headings back', () => {
    expect(readSectionHeading(sectionHeading({ number: '6.2', title: 'Definition' }))).toEqual({ number: '6.2', title: 'Definition' });
    expect(readChapterHeading('Chapter 6: The economics of trade')).toEqual({ number: 6, title: 'The economics of trade' });
    expect(readChapterHeading('Chapter 6.2 Definition')).toBeNull();
    expect(['6.10', '6.2', '6.1'].sort(compareSectionNumbers)).toEqual(['6.1', '6.2', '6.10']);
  });
});

// ---------------------------------------------------------------------------
// The shipped textbook packs
// ---------------------------------------------------------------------------

const texts = (doc: DocNode): string[] => {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    if (n.type === 'text' && n.text) out.push(n.text);
    n.content?.forEach(walk);
  };
  walk(doc);
  return out;
};
const all = (drafts: DraftRem[]): DraftRem[] => drafts.flatMap((d) => [d, ...all(d.children ?? [])]);
const isCard = (d: DraftRem) => splitOnSeparator(d.doc) !== null || extractClozeIndices(d.doc).length > 0;

// Units 1–2 positions each subject's study design has (checked against the .docx).
const POSITIONS: Record<string, RegExp> = {
  'vce-economics': /^U(1\.1\.[1-3]|1\.[23]\.[12]|2\.[12]\.[12])\.\d+$/,
};

describe.each(CATALOGUE.filter((s) => s.textbook))('the $id textbook pack', async ({ id }) => {
  const chapters = await loadTextbook(id);
  const sections = chapters.flatMap((c) => c.sections);

  it('has unique, ordered sections that cover real study-design positions', () => {
    expect(sections.length).toBeGreaterThan(0);
    expect(new Set(sections.map((s) => s.number)).size).toBe(sections.length);
    for (const c of chapters) {
      const numbers = c.sections.map((s) => s.number);
      expect(numbers, `chapter ${c.number}`).toEqual([...numbers].sort(compareSectionNumbers));
    }
    for (const s of sections) for (const pos of s.covers) expect(pos, s.number).toMatch(POSITIONS[id]!);
  });

  it('follows the lesson shape: In a sentence first, Flashcards last, answered practice questions', () => {
    for (const s of sections) {
      const titles = s.drafts.map((d) => texts(d.doc).join(''));
      expect(titles[0], s.number).toBe('In a sentence');
      expect(titles.at(-1), s.number).toBe('Flashcards');
      expect(titles, s.number).toContain('Key terms');
      const practice = s.drafts.find((d) => texts(d.doc).join('') === 'Practice questions');
      expect(practice?.children?.length ?? 0, s.number).toBeGreaterThanOrEqual(2);
      for (const q of practice?.children ?? []) {
        expect(q.children?.length ?? 0, s.number).toBeGreaterThan(0);
        expect(all([q]).some(isCard), s.number).toBe(false);
      }
      expect(all(s.drafts).filter(isCard).length, s.number).toBeGreaterThanOrEqual(4);
      // A bold section title longer than 60 characters wouldn't draw as a heading in the lesson.
      for (const d of s.drafts) if (d.children?.length) expect(texts(d.doc).join('').length, s.number).toBeLessThanOrEqual(60);
    }
  });

  it('leaves no stray markup, mixes no cloze with ::, and only has maths KaTeX can render', () => {
    for (const s of sections) {
      for (const d of all(s.drafts)) {
        const plain = texts(d.doc).join('');
        for (const t of texts(d.doc)) expect(t, `${s.number}: ${t}`).not.toMatch(/\*\*|\{\{|\}\}|`/);
        expect(plain.includes(CARD_SEPARATOR) && extractClozeIndices(d.doc).length > 0, `${s.number}: ${plain}`).toBe(false);
        const walk = (n: DocNode) => {
          if (n.type === 'math') expect(() => katex.renderToString(String(n.attrs?.latex), { throwOnError: true })).not.toThrow();
          n.content?.forEach(walk);
        };
        walk(d.doc);
      }
    }
  });
});
