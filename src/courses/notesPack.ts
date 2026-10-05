import type { DraftRem } from '../db/treeInsert';
import type { DocNode } from '../tiptap/docUtils';
import type { Roadmap } from './courseTree';

/**
 * Ready-made study notes for a course: explanations, worked examples, common
 * mistakes and flashcards, filed under each dot point by the roadmap's "Add
 * study notes" button.
 *
 * The notes are original writing, so they can live in this public repo; the
 * dot points they belong to are VCAA's, so they don't. Each entry is keyed by
 * a hash of its dot point's wording (plus the dot point's position as a
 * fallback), never by the wording itself.
 *
 * ## The pack format
 *
 *     @ 9f2c01ab U1.1.1.1 | Elements, isotopes and ions      ← hash, position, a label of our own
 *     An element is made of one kind of atom.                ← a rem
 *       Every atom of it has the same number of protons.     ← two spaces deeper = a child
 *     **Worked example**                                     ← bold
 *     Molar mass :: the mass of one mole, in g mol⁻¹         ← a flashcard (as typed in the app)
 *     Isotopes differ in their number of {{neutrons}}.       ← a cloze card
 *     Amount $n = \frac{m}{M}$                               ← maths (KaTeX)
 *     It costs \$4.50.                                       ← a literal dollar sign
 *     `code`                                                 ← inline code
 *
 * A line starting `% ` in the first column is a comment (an indented `%(m/v)`
 * is text). Blank lines are ignored.
 */

export interface PackEntry {
  /** `pointKey` of the dot point's text. */
  key: string;
  /** "U1.1.1.1" (unit.area.group.point) or "S.1.1" (skills group.point). */
  position: string;
  label: string;
  drafts: DraftRem[];
}

/**
 * A dot point's identity: FNV-1a over its letters and digits, lower-cased and
 * Unicode-normalised (so `H₂O` and `H2O`, or a changed dash, still match).
 */
export function pointKey(text: string): string {
  const normalised = text.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalised.length; i++) {
    hash ^= normalised.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Inline markup
// ---------------------------------------------------------------------------

const TOKEN = /\*\*([^*]+)\*\*|`([^`]+)`|\$([^$]+)\$|\{\{([^}]+)\}\}/g;

/** `\$` is a literal dollar sign; it stands in as a private-use character while the line is tokenised. */
const ESCAPED_DOLLAR = /\\\$/g;
const DOLLAR_STAND_IN = '\uE000';
const restoreDollars = (text: string) => text.replaceAll(DOLLAR_STAND_IN, '$');

function inline(source: string): DocNode[] {
  const text = source.replace(ESCAPED_DOLLAR, DOLLAR_STAND_IN);
  const out: DocNode[] = [];
  let cursor = 0;
  let cloze = 0;
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(text)) !== null) {
    if (m.index > cursor) out.push({ type: 'text', text: restoreDollars(text.slice(cursor, m.index)) });
    const [whole, bold, code, math, blank] = m;
    if (bold !== undefined) out.push({ type: 'text', text: restoreDollars(bold), marks: [{ type: 'bold' }] });
    else if (code !== undefined) out.push({ type: 'text', text: restoreDollars(code), marks: [{ type: 'code' }] });
    else if (math !== undefined) out.push({ type: 'math', attrs: { latex: restoreDollars(math) } });
    else if (blank !== undefined) {
      cloze += 1;
      out.push({ type: 'cloze', attrs: { index: cloze, text: restoreDollars(blank), state: null } });
    }
    cursor = m.index + whole.length;
  }
  if (cursor < text.length) out.push({ type: 'text', text: restoreDollars(text.slice(cursor)) });
  return out;
}

export function lineToDoc(text: string): DocNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: inline(text) }] };
}

// ---------------------------------------------------------------------------
// Pack text → entries
// ---------------------------------------------------------------------------

const HEADER = /^@\s+([0-9a-f]{8})\s+((?:U\d+\.\d+\.\d+\.\d+)|(?:S\.\d+\.\d+))\s*\|\s*(.*)$/;

export function parsePack(source: string): PackEntry[] {
  const entries: PackEntry[] = [];
  let current: PackEntry | null = null;
  // The open rem at each depth, so a deeper line becomes its child.
  let stack: DraftRem[] = [];

  source.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim() || raw.startsWith('% ')) return;
    const header = HEADER.exec(raw.trim());
    if (header) {
      current = { key: header[1]!, position: header[2]!, label: header[3]!.trim(), drafts: [] };
      entries.push(current);
      stack = [];
      return;
    }
    if (!current) throw new Error(`Pack line ${i + 1}: text before the first "@" header.`);
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) throw new Error(`Pack line ${i + 1}: indent by two spaces.`);
    const depth = indent / 2;
    if (depth > stack.length) throw new Error(`Pack line ${i + 1}: indented too far.`);
    // An odd number of unescaped `$` would leave a stray one in the text (write `\$` for money).
    if ((raw.replace(ESCAPED_DOLLAR, '').match(/\$/g)?.length ?? 0) % 2 !== 0) {
      throw new Error(`Pack line ${i + 1}: unmatched "$" — write \\$ for a dollar sign.`);
    }
    const rem: DraftRem = { doc: lineToDoc(raw.trim()) };
    if (depth === 0) (current as PackEntry).drafts.push(rem);
    else (stack[depth - 1]!.children ??= []).push(rem);
    stack = stack.slice(0, depth);
    stack.push(rem);
  });
  return entries;
}

// ---------------------------------------------------------------------------
// Entries → dot points
// ---------------------------------------------------------------------------

export interface PackPlacement {
  pointId: string;
  entry: PackEntry;
}

export interface PackPlan {
  place: PackPlacement[];
  /** Matched, but the dot point already has notes of the user's — left alone. */
  skipped: number;
  /** Entries whose dot point isn't in this course (reworded, deleted, or a unit not imported). */
  unmatched: PackEntry[];
}

/**
 * Where each entry goes. Wording first; position only for an entry whose
 * wording matched nothing and whose position holds a dot point that no other
 * entry claimed — a lightly revised study design keeps its notes, and a
 * reordered one doesn't get the wrong ones.
 */
export function planPack(
  entries: readonly PackEntry[],
  roadmap: Roadmap,
  hasOwnNotes: (pointId: string) => boolean
): PackPlan {
  const points: Array<{ id: string; key: string; position: string }> = [];
  for (const unit of roadmap.units) {
    for (const area of unit.areas) {
      area.groups.forEach((group, gi) =>
        group.points.forEach((p, pi) =>
          points.push({ id: p.id, key: pointKey(p.text), position: `U${unit.number}.${area.number}.${gi + 1}.${pi + 1}` })
        )
      );
    }
  }
  roadmap.skills?.groups.forEach((group, gi) =>
    group.points.forEach((p, pi) => points.push({ id: p.id, key: pointKey(p.text), position: `S.${gi + 1}.${pi + 1}` }))
  );

  // Several dot points can share wording (a key skill repeated in every area),
  // so a key can name more than one point.
  const byKey = new Map<string, typeof points>();
  for (const p of points) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
  const byPosition = new Map(points.map((p) => [p.position, p]));
  const claimed = new Set<string>();
  const matched = new Map<PackEntry, string>();
  const claim = (entry: PackEntry, point: (typeof points)[number] | undefined) => {
    if (!point) return;
    claimed.add(point.id);
    matched.set(entry, point.id);
  };

  // Same wording in the same place first, then the same wording anywhere.
  for (const entry of entries) {
    claim(entry, byKey.get(entry.key)?.find((p) => p.position === entry.position && !claimed.has(p.id)));
  }
  for (const entry of entries) {
    if (!matched.has(entry)) claim(entry, byKey.get(entry.key)?.find((p) => !claimed.has(p.id)));
  }
  const entryKeys = new Set(entries.map((e) => e.key));
  for (const entry of entries) {
    if (matched.has(entry)) continue;
    const point = byPosition.get(entry.position);
    if (point && !claimed.has(point.id) && !entryKeys.has(point.key)) {
      claimed.add(point.id);
      matched.set(entry, point.id);
    }
  }

  const plan: PackPlan = { place: [], skipped: 0, unmatched: [] };
  for (const entry of entries) {
    const pointId = matched.get(entry);
    if (!pointId) plan.unmatched.push(entry);
    else if (hasOwnNotes(pointId)) plan.skipped += 1;
    else plan.place.push({ pointId, entry });
  }
  return plan;
}
