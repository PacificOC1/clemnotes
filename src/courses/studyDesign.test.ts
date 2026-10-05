import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { countPoints, docxToLines, parseStudyDesign, textToLines, type SourceLine } from './studyDesign';

/*
 * Fixtures follow the layout of a VCAA study design with invented wording —
 * the real text is VCAA's and isn't committed to this public repo. The real
 * Chemistry .docx was checked by hand: 6 areas of study, 85 dot points, 34
 * key science skills for Units 1–2. The Biology .docx (2022–2026) parses with
 * no warnings to 6 areas, 58 dot points and 32 key science skills. The English
 * Language .docx (2024–2028) has no study-wide skills: its 4 areas give 35 key
 * knowledge points and 19 key skills, each area's skills in their own group.
 * The Economics .docx (from 2023) is laid out the same way: 5 areas, 54 key
 * knowledge points and 25 key skills; U1 AoS 1 has two titled key-knowledge
 * groups, so its key skills are the third group.
 */

type Para = { style?: string; text: string; runs?: Array<{ text: string; align?: 'superscript' | 'subscript' }>; num?: boolean };

function docx(paras: Para[]): Uint8Array {
  const body = paras
    .map((p) => {
      const props = `${p.style ? `<w:pStyle w:val="${p.style}"/>` : ''}${p.num ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>' : ''}`;
      const runs = (p.runs ?? [{ text: p.text }])
        .map(
          (r) =>
            `<w:r><w:rPr>${r.align ? `<w:vertAlign w:val="${r.align}"/>` : ''}</w:rPr><w:t xml:space="preserve">${r.text
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')}</w:t></w:r>`
        )
        .join('');
      return `<w:p><w:pPr>${props}</w:pPr>${runs}</w:p>`;
    })
    .join('');
  const xml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`;
  return zipSync({ 'word/document.xml': strToU8(xml), '[Content_Types].xml': strToU8('<Types/>') });
}

const H = (level: number, text: string): Para => ({ style: `VCAAHeading${level}`, text });
const B = (text: string): Para => ({ style: 'VCAAbullet', text });
const B2 = (text: string): Para => ({ style: 'VCAAbulletlevel2', text });
const P = (text: string): Para => ({ style: 'VCAAbody', text });

const SAMPLE: Para[] = [
  { style: 'TOC1', text: 'Unit 1: Why do things fizz?23' },
  { style: 'TOC2', text: 'Area of Study 123' },
  B('Unit 1: Why do things fizz?'),
  B('Unit 2: Where does the fizz go?'),
  H(2, 'Key science skills'),
  P('The key science skills apply across Units 1 to 4 in all areas of study, which is a long sentence of prose.'),
  P('Key science skill'),
  P('VCE Fizzology Units 1–4'),
  P('Ask questions'),
  { text: 'pose a question', num: true },
  { text: 'predict an outcome', num: true },
  P('Measure things'),
  { text: 'record data in a logbook', num: true },
  H(2, 'Scientific investigation'),
  P('Students undertake investigations across Units 1 to 4.'),
  H(1, 'Unit 1: Why do things fizz?'),
  P('In this unit students look at bubbles.'),
  H(2, 'Area of Study 1'),
  H(3, 'How do bubbles form?'),
  P('In this area of study students blow bubbles.'),
  H(3, 'Outcome 1'),
  P('On completion of this unit the student should be able to explain bubbles.'),
  P('To achieve this outcome the student will draw on key knowledge outlined in Area of Study 1.'),
  H(4, 'Key knowledge'),
  H(5, 'Gas and liquid'),
  B('the solubility of gases in water'),
  { style: 'VCAAbullet', text: '', runs: [{ text: 'the number 6.02 × 10' }, { text: '23', align: 'superscript' }, { text: ' and H' }, { text: '2', align: 'subscript' }, { text: 'O' }] },
  H(5, 'Pressure'),
  B('pressure changes:'),
  B2('opening a bottle'),
  B2('shaking a bottle'),
  B('temperature & pressure'),
  H(2, 'Area of Study 2'),
  H(3, 'How is fizz measured?'),
  H(4, 'Investigation topic 1: Soda'),
  B('Which soda fizzes most?'),
  H(3, 'Outcome 2'),
  P('On completion of this unit the student should be able to measure fizz.'),
  H(4, 'Key knowledge'),
  B('the units of fizz'),
  H(2, 'Assessment'),
  P('Outcome 1 and Outcome 2'),
  B('a report'),
  P('Outcome 3'),
  P('Practical work is central to this study and this sentence should not become an outcome.'),
  H(1, 'Unit 2: Where does the fizz go?'),
  H(2, 'Area of Study 1'),
  H(3, 'Where does gas escape?'),
  H(3, 'Outcome 1'),
  P('On completion of this unit the student should be able to track gas.'),
  H(4, 'Key knowledge'),
  B('diffusion of gases'),
  H(1, 'Unit 3: Advanced fizz'),
  H(2, 'Area of Study 1'),
  H(3, 'What is advanced fizz?'),
  H(4, 'Key knowledge'),
  B('advanced fizz'),
];

describe('docxToLines', () => {
  it('reads paragraphs, list styles, headings and raised text', () => {
    const lines = docxToLines(docx(SAMPLE));
    expect(lines.find((l) => l.text === 'the solubility of gases in water')).toMatchObject({ bullet: true, heading: false });
    expect(lines.find((l) => l.text === 'Gas and liquid')).toMatchObject({ bullet: false, heading: true });
    expect(lines.find((l) => l.text === 'pose a question')?.bullet).toBe(true);
    expect(lines.find((l) => l.text === 'opening a bottle')?.level).toBe(2);
    expect(lines.some((l) => l.text === 'the number 6.02 × 10²³ and H₂O')).toBe(true);
    expect(lines.some((l) => l.text === 'temperature & pressure')).toBe(true);
  });

  it('refuses a file that is not a Word document', () => {
    expect(() => docxToLines(new Uint8Array([1, 2, 3]))).toThrow(/Word document/);
  });
});

describe('parseStudyDesign — .docx', () => {
  const { design, warnings } = parseStudyDesign(docxToLines(docx(SAMPLE)), { units: [1, 2], exact: true });

  it('keeps the units asked for, skipping contents entries and overview bullets', () => {
    expect(design.units.map((u) => [u.number, u.title])).toEqual([
      [1, 'Why do things fizz?'],
      [2, 'Where does the fizz go?'],
    ]);
    expect(warnings).toEqual([]);
  });

  it('keeps the introductions of units and areas', () => {
    expect(design.units[0]!.description).toEqual(['In this unit students look at bubbles.']);
    expect(design.units[0]!.areas[0]!.description).toEqual(['In this area of study students blow bubbles.']);
    // Investigation topics aren't an introduction.
    expect(design.units[0]!.areas[1]!.description).toEqual([]);
    expect(design.units[1]!.description).toEqual([]);
  });

  it('reads each area: its question, outcome and grouped key knowledge', () => {
    const [aos1, aos2] = design.units[0]!.areas;
    expect(aos1).toMatchObject({
      number: 1,
      title: 'How do bubbles form?',
      outcome: 'On completion of this unit the student should be able to explain bubbles.',
    });
    expect(aos1!.groups).toEqual([
      { title: 'Gas and liquid', points: ['the solubility of gases in water', 'the number 6.02 × 10²³ and H₂O'] },
      {
        title: 'Pressure',
        points: ['pressure changes: opening a bottle', 'pressure changes: shaking a bottle', 'temperature & pressure'],
      },
    ]);
    // Investigation-topic questions aren't key knowledge.
    expect(aos2!.groups).toEqual([{ title: null, points: ['the units of fizz'] }]);
  });

  it("doesn't let the assessment section rewrite an outcome", () => {
    expect(design.units[0]!.areas[1]!.outcome).toBe('On completion of this unit the student should be able to measure fizz.');
    expect(design.units[0]!.areas).toHaveLength(2);
  });

  it('reads the key science skills that come before Unit 1', () => {
    expect(design.skills).toEqual([
      { title: 'Ask questions', points: ['pose a question', 'predict an outcome'] },
      { title: 'Measure things', points: ['record data in a logbook'] },
    ]);
  });

  it('counts for the preview', () => {
    expect(countPoints(design)).toEqual({ areas: 3, points: 7, skills: 3, areaSkills: 0 });
  });

  it('keeps every unit when not told otherwise', () => {
    const all = parseStudyDesign(docxToLines(docx(SAMPLE)), { exact: true });
    expect(all.design.units.map((u) => u.number)).toEqual([1, 2, 3]);
  });
});

describe('parseStudyDesign — pasted text', () => {
  const pasted = [
    'VCE Fizzology Study Design 2024–2028',
    'Unit 1: Why do things fizz?',
    'Area of Study 1',
    'How do bubbles form?',
    'Outcome 1',
    'On completion of this unit the student should be able to',
    'explain bubbles.',
    'To achieve this outcome the student will draw on key knowledge.',
    'Key knowledge',
    'Gas and liquid',
    '• the solubility of gases in water, including the effect of',
    'temperature on it',
    '• surface tension',
    '14',
    '© VCAA',
    'Pressure',
    '• pressure changes:',
    '   ◦ opening a bottle',
    '   ◦ shaking a bottle',
    'Assessment',
  ].join('\n');

  it('joins wrapped dot points, skips page furniture, splits nested points', () => {
    const { design } = parseStudyDesign(textToLines(pasted), { units: [1] });
    const area = design.units[0]!.areas[0]!;
    expect(area.outcome).toBe('On completion of this unit the student should be able to explain bubbles.');
    expect(area.groups).toEqual([
      {
        title: 'Gas and liquid',
        points: ['the solubility of gases in water, including the effect of temperature on it', 'surface tension'],
      },
      { title: 'Pressure', points: ['pressure changes: opening a bottle', 'pressure changes: shaking a bottle'] },
    ]);
  });

  it('sorts dot points from sub-headings when the bullets were lost in the copy', () => {
    const noBullets = pasted.replace(/^[ •◦]+/gm, '');
    const lines: SourceLine[] = textToLines(noBullets);
    const { design } = parseStudyDesign(lines, { units: [1], exact: true });
    const groups = design.units[0]!.areas[0]!.groups;
    expect(groups.map((g) => g.title)).toEqual(['Gas and liquid', 'Pressure']);
    expect(groups[0]!.points[0]).toBe('the solubility of gases in water, including the effect of');
  });

  it('says so when it finds nothing', () => {
    const { design, warnings } = parseStudyDesign(textToLines('just some notes\nnothing here'), { units: [1, 2] });
    expect(design.units).toEqual([]);
    expect(warnings[0]).toMatch(/Couldn't find Unit 1 or Unit 2/);
  });
});

describe('parseStudyDesign — key skills per outcome', () => {
  // The English Language layout: no study-wide skills, and each outcome lists
  // key knowledge (no sub-headings) followed by its own key skills.
  const PER_OUTCOME: Para[] = [
    H(1, 'Unit 1: Talking'),
    H(2, 'Area of Study 1'),
    H(3, 'How do we talk?'),
    H(3, 'Outcome 1'),
    P('On completion of this unit the student should be able to describe talk.'),
    H(4, 'Key knowledge'),
    B('the sounds of speech'),
    B('the words we choose'),
    H(4, 'Key skills'),
    B('describe speech using metalanguage'),
    H(2, 'Area of Study 2'),
    H(3, 'How do children learn to talk?'),
    H(3, 'Outcome 2'),
    P('On completion of this unit the student should be able to discuss acquisition.'),
    H(4, 'Key knowledge'),
    B('stages of acquisition'),
    H(4, 'Key skills'),
    B('interpret child language samples'),
    H(2, 'Assessment'),
    B('an essay'),
  ];
  const { design, warnings } = parseStudyDesign(docxToLines(docx(PER_OUTCOME)), { units: [1], exact: true });

  it('gives each area a key knowledge group and a key skills group', () => {
    expect(warnings).toEqual([]);
    expect(design.skills).toEqual([]);
    expect(design.units[0]!.areas.map((a) => a.groups)).toEqual([
      [
        { title: 'Key knowledge', points: ['the sounds of speech', 'the words we choose'] },
        { title: 'Key skills', points: ['describe speech using metalanguage'] },
      ],
      [
        { title: 'Key knowledge', points: ['stages of acquisition'] },
        { title: 'Key skills', points: ['interpret child language samples'] },
      ],
    ]);
    expect(countPoints(design)).toEqual({ areas: 2, points: 3, skills: 0, areaSkills: 2 });
  });
});
