/**
 * Fill in the dot-point keys of a study-notes pack (src/courses/packs/…).
 *
 * Pack entries are written with a placeholder and a position:
 *
 *     @ ________ U3.1.2.4 | a label of our own
 *
 * This reads the study design (VCAA's .docx — not in the repo) with the same
 * parser the app uses, and replaces the placeholder (or a stale key) with the
 * hash of the dot point at that position, so the pack never has to contain
 * VCAA's wording. It also lists positions with no notes yet.
 *
 *     npx tsx scripts/course-pack-keys.ts <study-design.docx> <pack-dir> [units, e.g. 1,2]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { docxToLines, parseStudyDesign } from '../src/courses/studyDesign';
import { pointKey } from '../src/courses/notesPack';

const [docx, dir, unitsArg = '1,2'] = process.argv.slice(2);
if (!docx || !dir) {
  console.error('usage: npx tsx scripts/course-pack-keys.ts <study-design.docx> <pack-dir> [units]');
  process.exit(1);
}

const units = unitsArg.split(',').map(Number);
const { design, warnings } = parseStudyDesign(docxToLines(new Uint8Array(readFileSync(docx))), { units, exact: true });
for (const w of warnings) console.warn(`warning: ${w}`);

const byPosition = new Map<string, string>();
for (const u of design.units) {
  for (const a of u.areas) {
    a.groups.forEach((g, gi) => g.points.forEach((p, pi) => byPosition.set(`U${u.number}.${a.number}.${gi + 1}.${pi + 1}`, p)));
  }
}
design.skills.forEach((g, gi) => g.points.forEach((p, pi) => byPosition.set(`S.${gi + 1}.${pi + 1}`, p)));

const seen = new Set<string>();
for (const file of readdirSync(dir).filter((f) => f.endsWith('.txt'))) {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8').replace(/^@ (?:_{8}|[0-9a-f]{8}) (\S+) \|/gm, (_, position: string) => {
    const point = byPosition.get(position);
    if (!point) throw new Error(`${file}: the study design has no dot point at ${position}`);
    if (seen.has(position)) throw new Error(`${file}: ${position} appears twice`);
    seen.add(position);
    return `@ ${pointKey(point)} ${position} |`;
  });
  writeFileSync(path, text);
}

const missing = [...byPosition.keys()].filter((p) => !seen.has(p));
console.log(`${seen.size} of ${byPosition.size} dot points have notes.${missing.length ? ` Missing: ${missing.join(' ')}` : ''}`);
