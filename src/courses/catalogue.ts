/**
 * The subjects the Courses tab offers.
 *
 * An entry is only a name and where to get its study design: the content
 * itself is imported by the user from VCAA's own file (see `studyDesign.ts`
 * for why it isn't bundled). Adding a subject is adding an entry here.
 */
export interface CatalogueSubject {
  id: string;
  /** The page title an imported course gets — and how it is found again. */
  title: string;
  /** "VCE" etc., shown as a small label. */
  curriculum: string;
  /** Which units the importer keeps. */
  units: readonly number[];
  /** Units the study design has that aren't supported yet — shown as "later" on the roadmap. */
  laterUnits: readonly number[];
  /** Accreditation period of the study design this was written against. */
  accredited: string;
  /** Where to download it. */
  sourceUrl: string;
  sourceName: string;
  /**
   * Short names of our own for units ("U1") and areas of study ("U1.2"), shown
   * above the study design's question. Anything missing falls back to the question.
   */
  shortNames?: Readonly<Record<string, string>>;
}

export const CATALOGUE: readonly CatalogueSubject[] = [
  {
    id: 'vce-chemistry',
    title: 'VCE Chemistry',
    curriculum: 'VCE',
    units: [1, 2],
    // TODO(courses): Units 3–4 — the parser already reads them (they share the
    // layout); they need checking against the study design, then add them to
    // `units` and teach `importStudyDesign` to add units to an existing course.
    laterUnits: [3, 4],
    accredited: '2023–2027',
    sourceUrl: 'https://www.vcaa.vic.edu.au/curriculum/vce/vce-study-designs/chemistry',
    sourceName: 'VCAA Chemistry study design (.docx)',
    shortNames: {
      U1: 'Diversity of materials',
      'U1.1': 'Structure, bonding and properties',
      'U1.2': 'Quantifying and classifying materials',
      'U1.3': 'Research investigation: a sustainable future',
      U2: 'Reactions in the natural world',
      'U2.1': 'Water, acids, bases and redox',
      'U2.2': 'Measuring and analysing chemicals',
      'U2.3': 'Practical investigation',
    },
  },
  {
    id: 'vce-biology',
    title: 'VCE Biology',
    curriculum: 'VCE',
    units: [1, 2],
    // TODO(courses): Units 3–4, as for Chemistry. The 2022 study design's
    // accreditation ends 31 Dec 2026 — check VCAA for a successor before 2027.
    laterUnits: [3, 4],
    accredited: '2022–2026',
    sourceUrl: 'https://www.vcaa.vic.edu.au/curriculum/vce-curriculum/vce-study-designs/biology/biology',
    sourceName: 'VCAA Biology study design (.docx)',
    shortNames: {
      U1: 'Cells, systems and homeostasis',
      'U1.1': 'Cell structure, division and death',
      'U1.2': 'Plant and animal systems',
      'U1.3': 'Practical investigation',
      U2: 'Inheritance, reproduction and diversity',
      'U2.1': 'Chromosomes, genetics and inheritance',
      'U2.2': 'Reproduction, adaptation and ecosystems',
      'U2.3': 'Research investigation: a bioethical issue',
    },
  },
  {
    id: 'vce-english-language',
    title: 'VCE English Language',
    curriculum: 'VCE',
    units: [1, 2],
    // TODO(courses): Units 3–4. Each area has key knowledge and its own key
    // skills (no study-wide key science skills) — see `KEY_SKILLS_TITLE`.
    laterUnits: [3, 4],
    accredited: '2024–2028',
    sourceUrl: 'https://www.vcaa.vic.edu.au/curriculum/vce-curriculum/vce-study-designs/english-language/english-language',
    sourceName: 'VCAA English Language study design (.docx)',
    shortNames: {
      U1: 'How language works and how we learn it',
      'U1.1': 'What language is and what it does',
      'U1.2': 'How children and adults learn language',
      U2: 'How English has changed',
      'U2.1': 'The history of English',
      'U2.2': 'English around the world',
    },
  },
  {
    id: 'vce-economics',
    title: 'VCE Economics',
    curriculum: 'VCE',
    units: [1, 2],
    // TODO(courses): Units 3–4. Like English Language, each area has its own
    // key skills; U1 AoS 1's key knowledge has two sub-headings, so its key
    // skills are the area's third group.
    laterUnits: [3, 4],
    accredited: 'from 2023',
    sourceUrl: 'https://www.vcaa.vic.edu.au/curriculum/vce-curriculum/vce-study-designs/economics/vce-economics',
    sourceName: 'VCAA Economics study design (.docx)',
    shortNames: {
      U1: 'How people, businesses and governments decide',
      'U1.1': 'Scarcity, choice and the economic agents',
      'U1.2': 'Demand, supply and competition',
      'U1.3': 'Why people don’t always act rationally',
      U2: 'Growth, living standards and big issues',
      'U2.1': 'Economic activity, growth and the business cycle',
      'U2.2': 'Investigating two economic issues',
    },
  },
];

export function catalogueSubject(id: string): CatalogueSubject | undefined {
  return CATALOGUE.find((s) => s.id === id);
}

/** "Units 1–2", "Unit 3", "Units 1, 3". */
export function unitsLabel(units: readonly number[]): string {
  if (units.length === 0) return '';
  if (units.length === 1) return `Unit ${units[0]}`;
  const sorted = [...units].sort((a, b) => a - b);
  const consecutive = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  return consecutive ? `Units ${sorted[0]}–${sorted[sorted.length - 1]}` : `Units ${sorted.join(', ')}`;
}
