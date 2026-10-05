import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { lineToDoc, parsePack, planPack, pointKey, type PackEntry } from './notesPack';
import { loadPack } from './packs';
import type { Roadmap } from './courseTree';
import { CARD_SEPARATOR, extractClozeIndices, splitOnSeparator, type DocNode } from '../tiptap/docUtils';

describe('pointKey', () => {
  it('ignores case, spacing, punctuation and sub/superscript forms', () => {
    expect(pointKey('the use of H₂O — water')).toBe(pointKey('The use of H2O - water'));
    expect(pointKey('a')).not.toBe(pointKey('b'));
    expect(pointKey('anything')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('parsePack', () => {
  const pack = `% a comment
@ 0000000a U1.1.1.1 | First
**Key ideas**
  An element has one kind of atom.
    Nested deeper.
  Second child with $n = \\frac{m}{M}$ and \`code\`.
Card front :: card back
The answer is {{one}} and {{two}}.

@ 0000000b S.1.1 | Second
  %(m/v) means grams per 100 mL — indented, so not a comment.
`;

  it('reads headers, nesting and inline markup', () => {
    // The second entry's only line is indented at depth 1 with no parent — an error.
    expect(() => parsePack(pack)).toThrow(/indented too far/);
    const entries = parsePack(pack.replace('  %(m/v)', '%(m/v)'));
    expect(entries.map((e) => [e.key, e.position, e.label])).toEqual([
      ['0000000a', 'U1.1.1.1', 'First'],
      ['0000000b', 'S.1.1', 'Second'],
    ]);
    const [first] = entries;
    expect(first!.drafts).toHaveLength(3);
    const key = first!.drafts[0]!;
    expect(key.doc.content![0]!.content![0]).toEqual({ type: 'text', text: 'Key ideas', marks: [{ type: 'bold' }] });
    expect(key.children).toHaveLength(2);
    expect(key.children![0]!.children).toHaveLength(1);
    const inline = key.children![1]!.doc.content![0]!.content!;
    expect(inline.find((n) => n.type === 'math')?.attrs).toEqual({ latex: 'n = \\frac{m}{M}' });
    expect(inline.find((n) => n.marks?.[0]?.type === 'code')?.text).toBe('code');
    expect(extractClozeIndices(first!.drafts[2]!.doc)).toEqual([1, 2]);
    expect(splitOnSeparator(first!.drafts[1]!.doc)).not.toBeNull();
    expect(entries[1]!.drafts[0]!.doc.content![0]!.content![0]!.text).toMatch(/^%\(m\/v\)/);
  });

  it('refuses text before a header and odd indents', () => {
    expect(() => parsePack('text\n@ 0000000a U1.1.1.1 | x')).toThrow(/before the first/);
    expect(() => parsePack('@ 0000000a U1.1.1.1 | x\nA\n   B')).toThrow(/two spaces/);
  });

  it('reads \\$ as a dollar sign, beside maths and inside bold or a cloze', () => {
    const [entry] = parsePack('@ 0000000a U1.1.1.1 | x\nIt costs \\$4.50 and $x^2$ is maths.\n**\\$26.44** an hour, or {{\\$1 004.90}} a week.');
    const first = entry!.drafts[0]!.doc.content![0]!.content!;
    expect(first.map((n) => n.text ?? n.type)).toEqual(['It costs $4.50 and ', 'math', ' is maths.']);
    expect(first[1]!.attrs).toEqual({ latex: 'x^2' });
    const second = entry!.drafts[1]!.doc.content![0]!.content!;
    expect(second[0]).toEqual({ type: 'text', text: '$26.44', marks: [{ type: 'bold' }] });
    expect(second.find((n) => n.type === 'cloze')?.attrs?.text).toBe('$1 004.90');
  });

  it('refuses an unmatched dollar sign', () => {
    expect(() => parsePack('@ 0000000a U1.1.1.1 | x\nIt costs $4.50.')).toThrow(/unmatched "\$"/);
  });
});

function roadmapWith(points: Array<{ id: string; text: string }>, skills: Array<{ id: string; text: string }> = []): Roadmap {
  const p = (x: { id: string; text: string }) => ({ ...x, status: 'todo' as const, notes: 0, cards: 0, due: 0, fresh: 0 });
  const tally = { points: 0, started: 0, withCards: 0, studied: 0, mastered: 0, cards: 0, due: 0, fresh: 0 };
  return {
    pageId: 'page',
    title: 'T',
    units: [
      {
        id: 'u1',
        number: 1,
        title: 'U',
        description: [],
        tally,
        areas: [{ id: 'a1', number: 1, title: 'A', description: [], outcome: null, tally, groups: [{ id: 'g1', title: 'G', points: points.map(p) }] }],
      },
    ],
    skills: skills.length ? { id: 's', tally, groups: [{ id: 'sg', title: 'S', points: skills.map(p) }] } : null,
    tally,
    next: null,
  };
}

const entry = (key: string, position: string): PackEntry => ({ key, position, label: position, drafts: [{ doc: lineToDoc('x') }] });

describe('planPack', () => {
  it('matches by wording, then by position for entries whose wording changed', () => {
    const roadmap = roadmapWith(
      [
        { id: 'p1', text: 'first point' },
        { id: 'p2', text: 'second point, reworded by VCAA' },
        { id: 'p3', text: 'third point' },
      ],
      [{ id: 's1', text: 'a skill' }]
    );
    const plan = planPack(
      [
        entry(pointKey('third point'), 'U1.1.1.1'), // moved: wording wins over position
        entry(pointKey('second point'), 'U1.1.1.2'), // reworded: falls back to its position
        entry(pointKey('first point'), 'U1.1.1.3'),
        entry(pointKey('a skill'), 'S.1.1'),
        entry(pointKey('gone'), 'U1.9.9.9'),
      ],
      roadmap,
      () => false
    );
    expect(plan.place.map((p) => [p.entry.position, p.pointId])).toEqual([
      ['U1.1.1.1', 'p3'],
      ['U1.1.1.2', 'p2'],
      ['U1.1.1.3', 'p1'],
      ['S.1.1', 's1'],
    ]);
    expect(plan.unmatched.map((e) => e.position)).toEqual(['U1.9.9.9']);
  });

  it("doesn't use a position whose dot point another entry's wording will claim", () => {
    const roadmap = roadmapWith([{ id: 'p1', text: 'alpha' }, { id: 'p2', text: 'beta' }]);
    const plan = planPack([entry(pointKey('zzz'), 'U1.1.1.1'), entry(pointKey('alpha'), 'U1.1.1.2')], roadmap, () => false);
    expect(plan.place.map((p) => p.pointId)).toEqual(['p1']);
    expect(plan.unmatched).toHaveLength(1);
  });

  it('gives each of several dot points with the same wording the entry written for its place', () => {
    const roadmap: Roadmap = roadmapWith([
      { id: 'p1', text: 'define the terms' },
      { id: 'p2', text: 'something else' },
      { id: 'p3', text: 'define the terms' },
    ]);
    const key = pointKey('define the terms');
    const plan = planPack([entry(key, 'U1.1.1.3'), entry(key, 'U1.1.1.1')], roadmap, () => false);
    expect(plan.place.map((p) => [p.entry.position, p.pointId])).toEqual([
      ['U1.1.1.3', 'p3'],
      ['U1.1.1.1', 'p1'],
    ]);
    // Moved elsewhere, a shared wording still finds a free dot point.
    const moved = planPack([entry(key, 'U1.1.1.7'), entry(key, 'U1.1.1.1')], roadmap, () => false);
    expect(moved.place.map((p) => [p.entry.position, p.pointId])).toEqual([
      ['U1.1.1.7', 'p3'],
      ['U1.1.1.1', 'p1'],
    ]);
  });

  it('leaves dot points with notes of their own alone', () => {
    const roadmap = roadmapWith([{ id: 'p1', text: 'alpha' }]);
    const plan = planPack([entry(pointKey('alpha'), 'U1.1.1.1')], roadmap, (id) => id === 'p1');
    expect(plan).toMatchObject({ place: [], skipped: 1, unmatched: [] });
  });
});

// ---------------------------------------------------------------------------
// The shipped packs
// ---------------------------------------------------------------------------

function texts(doc: DocNode): string[] {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    if (n.type === 'text' && n.text) out.push(n.text);
    n.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

function maths(doc: DocNode): string[] {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    if (n.type === 'math') out.push(String(n.attrs?.latex));
    n.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

// Counts checked by hand against each study design (Units 1–2 key knowledge + key science skills).
const SHIPPED = [
  { id: 'vce-chemistry', keyKnowledge: 85, skills: 34 },
  { id: 'vce-biology', keyKnowledge: 58, skills: 32 },
  // English Language has no study-wide skills; its per-area key skills (19) sit
  // under the areas, so they count with the 35 key knowledge points.
  { id: 'vce-english-language', keyKnowledge: 54, skills: 0 },
  // Economics likewise: 54 key knowledge + 25 per-area key skills.
  { id: 'vce-economics', keyKnowledge: 79, skills: 0 },
];

describe.each(SHIPPED)('the $id pack', async ({ id, keyKnowledge, skills }) => {
  const entries = await loadPack(id);
  const all = (drafts: PackEntry['drafts']): PackEntry['drafts'] => drafts.flatMap((d) => [d, ...all(d.children ?? [])]);

  it('covers every Units 1–2 dot point and key science skill exactly once', () => {
    const total = keyKnowledge + skills;
    expect(entries).toHaveLength(total);
    // Keys can repeat (a key skill with the same wording in several areas) — but
    // never at the same position, and entries sharing a key share a title,
    // since the lesson title is looked up by key.
    expect(new Set(entries.map((e) => `${e.key} ${e.position}`)).size).toBe(total);
    const labels = new Map<string, Set<string>>();
    for (const e of entries) labels.set(e.key, (labels.get(e.key) ?? new Set()).add(e.label));
    for (const [key, set] of labels) expect([...set], key).toHaveLength(1);
    expect(new Set(entries.map((e) => e.position)).size).toBe(total);
    expect(entries.filter((e) => e.position.startsWith('U'))).toHaveLength(keyKnowledge);
    // Keys are filled by scripts/course-pack-keys.ts, never left as placeholders.
    expect(entries.every((e) => /^[0-9a-f]{8}$/.test(e.key))).toBe(true);
  });

  it('has flashcards under every dot point (4+ for key knowledge, 2+ for skills)', () => {
    for (const e of entries) {
      const cards = all(e.drafts).filter((d) => splitOnSeparator(d.doc) || extractClozeIndices(d.doc).length > 0);
      expect(cards.length, `${e.position} ${e.label}`).toBeGreaterThanOrEqual(e.position.startsWith('U') ? 4 : 2);
    }
  });

  it('leaves no stray markup in the text, and every card has two sides', () => {
    for (const e of entries) {
      for (const d of all(e.drafts)) {
        for (const t of texts(d.doc)) {
          // A stray "$" can't get this far: parsePack rejects an unmatched one (money is written \\$).
          expect(t, `${e.position}: ${t}`).not.toMatch(/\*\*|\{\{|\}\}|`/);
        }
        const plain = texts(d.doc).join('');
        if (plain.includes(CARD_SEPARATOR)) expect(splitOnSeparator(d.doc), `${e.position}: ${plain}`).not.toBeNull();
        // A cloze and a :: in one rem: the cloze wins and the :: shows on the card.
        expect(plain.includes(CARD_SEPARATOR) && extractClozeIndices(d.doc).length > 0, `${e.position}: ${plain}`).toBe(false);
      }
    }
  });

  it('follows the shape in WRITING.md', () => {
    const titleOf = (d: PackEntry['drafts'][number]) => texts(d.doc).join('');
    for (const e of entries) {
      const sections = e.drafts.map(titleOf);
      const where = `${e.position} ${e.label}`;
      expect(sections[0], where).toBe('In a sentence');
      expect(sections.at(-1), where).toBe('Flashcards');
      const practice = e.drafts.find((d) => titleOf(d) === 'Practice questions');
      expect(practice?.children?.length ?? 0, where).toBeGreaterThanOrEqual(2);
      // Every practice question has an answer, and none of it is a flashcard (it would be scheduled).
      for (const q of practice?.children ?? []) {
        expect(q.children?.length ?? 0, `${where}: ${titleOf(q)}`).toBeGreaterThan(0);
        for (const d of all([q])) {
          const text = texts(d.doc).join('');
          expect(text.includes(CARD_SEPARATOR) || extractClozeIndices(d.doc).length > 0, `${where}: ${text}`).toBe(false);
        }
      }
      if (e.position.startsWith('U')) {
        expect(sections, where).toContain('Key terms');
        expect(sections, where).toContain('Connections');
      }
    }
  });

  it('only contains maths KaTeX can render', () => {
    for (const e of entries) {
      for (const d of all(e.drafts)) {
        for (const latex of maths(d.doc)) {
          expect(() => katex.renderToString(latex, { throwOnError: true }), `${e.position}: ${latex}`).not.toThrow();
        }
      }
    }
  });
});
