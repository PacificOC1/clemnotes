import { parsePack, type PackEntry } from '../notesPack';
import { parseTextbook, type TextbookChapterEntry } from '../textbook';

/**
 * Study-note packs by catalogue subject id. Each is a lazy chunk of plain
 * text (see `notesPack.ts` for the format), fetched only when "Add study
 * notes" is pressed.
 */
const PACKS: Record<string, () => Promise<string[]>> = {
  'vce-chemistry': () =>
    Promise.all([
      import('./vce-chemistry/u1-aos1.txt?raw'),
      import('./vce-chemistry/u1-aos2.txt?raw'),
      import('./vce-chemistry/u1-aos3.txt?raw'),
      import('./vce-chemistry/u2-aos1.txt?raw'),
      import('./vce-chemistry/u2-aos2.txt?raw'),
      import('./vce-chemistry/u2-aos3.txt?raw'),
      import('./vce-chemistry/skills.txt?raw'),
    ]).then((modules) => modules.map((m) => m.default)),
  'vce-biology': () =>
    Promise.all([
      import('./vce-biology/u1-aos1.txt?raw'),
      import('./vce-biology/u1-aos2.txt?raw'),
      import('./vce-biology/u1-aos3.txt?raw'),
      import('./vce-biology/u2-aos1.txt?raw'),
      import('./vce-biology/u2-aos2.txt?raw'),
      import('./vce-biology/u2-aos3.txt?raw'),
      import('./vce-biology/skills.txt?raw'),
    ]).then((modules) => modules.map((m) => m.default)),
  'vce-english-language': () =>
    Promise.all([
      import('./vce-english-language/u1-aos1.txt?raw'),
      import('./vce-english-language/u1-aos2.txt?raw'),
      import('./vce-english-language/u2-aos1.txt?raw'),
      import('./vce-english-language/u2-aos2.txt?raw'),
    ]).then((modules) => modules.map((m) => m.default)),
  'vce-economics': () =>
    Promise.all([
      import('./vce-economics/u1-aos1.txt?raw'),
      import('./vce-economics/u1-aos2.txt?raw'),
      import('./vce-economics/u1-aos3.txt?raw'),
      import('./vce-economics/u2-aos1.txt?raw'),
      import('./vce-economics/u2-aos2.txt?raw'),
    ]).then((modules) => modules.map((m) => m.default)),
};

export function hasPack(subjectId: string): boolean {
  return subjectId in PACKS;
}

export async function loadPack(subjectId: string): Promise<PackEntry[]> {
  const load = PACKS[subjectId];
  if (!load) return [];
  return (await load()).flatMap((text) => parsePack(text));
}

/** The pack's short title for each learning point, by `pointKey` of its wording. */
export async function loadPackTitles(subjectId: string): Promise<Map<string, string>> {
  return new Map((await loadPack(subjectId)).map((e) => [e.key, e.label]));
}

/**
 * Textbook packs: notes that follow a book's chapters (`textbook.ts`), one file
 * per chapter, each a lazy chunk like the study-note packs.
 */
const TEXTBOOKS: Record<string, () => Promise<string[]>> = {
  'vce-economics': () =>
    Promise.all([import('./vce-economics/textbook/chapter-6.txt?raw')]).then((modules) => modules.map((m) => m.default)),
};

export function hasTextbook(subjectId: string): boolean {
  return subjectId in TEXTBOOKS;
}

export async function loadTextbook(subjectId: string): Promise<TextbookChapterEntry[]> {
  const load = TEXTBOOKS[subjectId];
  if (!load) return [];
  return (await load()).flatMap((text) => parseTextbook(text)).sort((a, b) => a.number - b.number);
}
