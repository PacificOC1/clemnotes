import type { DraftRem } from '../db/treeInsert';
import type { Flashcard, OutlinerNode } from '../db/schema';
import { buildTreeIndex, materialIds, type TreeIndex } from '../db/cardScope';
import { parseDoc, type DocNode } from '../tiptap/docUtils';
import type { KeyKnowledgeGroup, StudyDesign } from './studyDesign';

/**
 * A course is an ordinary page — "everything is a rem" — laid out the way a
 * study design is:
 *
 *     VCE Chemistry                              (page, in the "Courses" folder)
 *       Key knowledge from the …                 (note)
 *       ## Unit 1: How can …?
 *         ### Area of Study 1: How do …?
 *           Outcome 1: On completion of …
 *           #### Elements and the periodic table
 *             the definitions of elements, …     ← a dot point; your notes go under it
 *       ## Key science skills
 *         #### Plan and conduct investigations
 *           …
 *
 * The roadmap is read back from that shape by wording ("Unit 1…", "Area of
 * Study 1…", "Outcome 1…") and by which rems are headings — not from stored
 * metadata. So nothing new syncs, and a dot point you add, reword or move by
 * hand is simply part of the course.
 */

// ---------------------------------------------------------------------------
// Design → rems
// ---------------------------------------------------------------------------

function paragraph(text: string): DocNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] };
}

function heading(level: number, text: string): DocNode {
  return { type: 'doc', content: [{ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] }] };
}

function groupDrafts(groups: KeyKnowledgeGroup[]): DraftRem[] {
  const out: DraftRem[] = [];
  for (const group of groups) {
    const points = group.points.map((p) => ({ doc: paragraph(p) }));
    if (group.title) out.push({ doc: heading(4, group.title), children: points });
    else out.push(...points);
  }
  return out;
}

export const SKILLS_HEADING = 'Key science skills';

export function designToDrafts(design: StudyDesign, intro: string): DraftRem[] {
  const drafts: DraftRem[] = [{ doc: paragraph(intro) }];
  for (const unit of design.units) {
    drafts.push({
      doc: heading(2, `Unit ${unit.number}: ${unit.title}`),
      children: [
        // A unit's introduction: plain rems beside its area headings.
        ...unit.description.map((text) => ({ doc: paragraph(text) })),
        ...unit.areas.map((area) => ({
          doc: heading(3, `Area of Study ${area.number}: ${area.title}`),
          children: [
            // An area's introduction goes before its outcome — that's how it's read back (only
            // when there is an outcome, or it would be taken for dot points).
            ...(area.outcome ? area.description.map((text) => ({ doc: paragraph(text) })) : []),
            ...(area.outcome ? [{ doc: paragraph(`Outcome ${area.number}: ${area.outcome}`) }] : []),
            ...groupDrafts(area.groups),
          ],
        })),
      ],
    });
  }
  if (design.skills.length > 0) {
    drafts.push({ doc: heading(2, SKILLS_HEADING), collapsed: true, children: groupDrafts(design.skills) });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Rems → roadmap
// ---------------------------------------------------------------------------

/**
 * - `todo`: nothing yet
 * - `notes`: something written under it or linking to it
 * - `cards`: flashcards among those notes
 * - `learning`: every card reviewed at least once
 * - `mastered`: every one of those cards reviewed and out at 21 days or more
 *
 * "Studied" (what the roadmap's progress counts) is `notes` (you wrote about
 * it and made no cards), `learning` or `mastered`. Not `cards`: a course
 * filled with ready-made notes starts every dot point there, and the point is
 * to learn them, not to have them.
 */
export type PointStatus = 'todo' | 'notes' | 'cards' | 'learning' | 'mastered';

export function isStudied(status: PointStatus): boolean {
  return status === 'notes' || status === 'learning' || status === 'mastered';
}

export const MASTERED_DAYS = 21;

export interface PointProgress {
  id: string;
  text: string;
  status: PointStatus;
  notes: number;
  cards: number;
  due: number;
  /** Cards never reviewed. */
  fresh: number;
}

export interface GroupProgress {
  id: string | null;
  title: string | null;
  points: PointProgress[];
}

export interface Tally {
  points: number;
  /** Anything beyond `todo`. */
  started: number;
  withCards: number;
  /** `notes`, `learning` or `mastered` — see `isStudied`. */
  studied: number;
  mastered: number;
  cards: number;
  due: number;
  /** Cards never reviewed. */
  fresh: number;
}

export interface AreaProgress {
  id: string;
  number: number;
  title: string;
  /** Introduction paragraphs (the plain rems before the outcome). */
  description: string[];
  outcome: string | null;
  groups: GroupProgress[];
  tally: Tally;
}

export interface UnitProgress {
  id: string;
  number: number;
  title: string;
  /** Introduction paragraphs (plain rems beside the area headings). */
  description: string[];
  areas: AreaProgress[];
  tally: Tally;
}

export interface Roadmap {
  pageId: string;
  title: string;
  units: UnitProgress[];
  skills: { id: string; groups: GroupProgress[]; tally: Tally } | null;
  tally: Tally;
  /** The first dot point not yet studied (every card reviewed), in study-design order. */
  next: { point: PointProgress; unit: UnitProgress; area: AreaProgress } | null;
}

const UNIT_TEXT = /^Unit\s+(\d+)\s*[:.–—-]?\s*(.*)$/i;
const AREA_TEXT = /^Area\s+of\s+Study\s+(\d+)\s*[:.–—-]?\s*(.*)$/i;
const OUTCOME_TEXT = /^Outcome\s+\d+\s*[:.–—-]\s*(.*)$/i;
const SKILLS_TEXT = /^Key\s+(?:science\s+)?skills$/i;

export function isHeadingRem(node: OutlinerNode): boolean {
  if (!node.content.includes('"heading"')) return false;
  return parseDoc(node.content).content?.[0]?.type === 'heading';
}

function hasSubstance(node: OutlinerNode): boolean {
  return node.plainText.trim() !== '' || node.isPortal || node.content.includes('"remImage"') || node.content.includes('"remPdf"');
}

function emptyTally(): Tally {
  return { points: 0, started: 0, withCards: 0, studied: 0, mastered: 0, cards: 0, due: 0, fresh: 0 };
}

function add(into: Tally, from: Tally): void {
  into.points += from.points;
  into.started += from.started;
  into.withCards += from.withCards;
  into.studied += from.studied;
  into.mastered += from.mastered;
  into.cards += from.cards;
  into.due += from.due;
  into.fresh += from.fresh;
}

function tallyGroups(groups: GroupProgress[]): Tally {
  const t = emptyTally();
  for (const g of groups) {
    for (const p of g.points) {
      t.points += 1;
      if (p.status !== 'todo') t.started += 1;
      if (p.cards > 0) t.withCards += 1;
      if (isStudied(p.status)) t.studied += 1;
      if (p.status === 'mastered') t.mastered += 1;
      t.fresh += p.fresh;
      t.cards += p.cards;
      t.due += p.due;
    }
  }
  return t;
}

/** The rems of a course section → its groups of dot points. */
function readGroups(
  parentId: string,
  index: TreeIndex,
  pointOf: (node: OutlinerNode) => PointProgress
): { description: string[]; outcome: string | null; groups: GroupProgress[] } {
  let outcome: string | null = null;
  const description: string[] = [];
  const groups: GroupProgress[] = [];
  const children = index.children.get(parentId) ?? [];
  // Plain rems before the outcome are the introduction, not dot points.
  const outcomeAt = children.findIndex((c) => !isHeadingRem(c) && OUTCOME_TEXT.test(c.plainText.trim()));
  for (const [i, child] of children.entries()) {
    if (i < outcomeAt && !isHeadingRem(child)) {
      if (child.plainText.trim()) description.push(child.plainText.trim());
      continue;
    }
    if (isHeadingRem(child)) {
      const points = (index.children.get(child.id) ?? []).filter((n) => !isHeadingRem(n) && n.plainText.trim()).map(pointOf);
      groups.push({ id: child.id, title: child.plainText.trim(), points });
      continue;
    }
    const outcomeMatch: RegExpExecArray | null = outcome === null ? OUTCOME_TEXT.exec(child.plainText.trim()) : null;
    if (outcomeMatch) {
      outcome = outcomeMatch[1]!.trim();
      continue;
    }
    if (!child.plainText.trim()) continue;
    const last = groups[groups.length - 1];
    if (last && last.id === null) last.points.push(pointOf(child));
    else groups.push({ id: null, title: null, points: [pointOf(child)] });
  }
  return { description, outcome, groups };
}

export function readRoadmap(
  pageId: string,
  nodes: readonly OutlinerNode[],
  cards: readonly Flashcard[],
  now = Date.now(),
  prebuilt?: TreeIndex
): Roadmap | null {
  const index = prebuilt ?? buildTreeIndex(nodes);
  const page = index.byId.get(pageId);
  if (!page) return null;

  const cardsByNode = new Map<string, Flashcard[]>();
  for (const card of cards) {
    if (card.deletedAt !== null || card.suspended) continue;
    const list = cardsByNode.get(card.nodeId);
    if (list) list.push(card);
    else cardsByNode.set(card.nodeId, [card]);
  }

  const pointOf = (node: OutlinerNode): PointProgress => {
    const material = materialIds(node.id, index);
    let notes = 0;
    const own: Flashcard[] = [...(cardsByNode.get(node.id) ?? [])];
    for (const id of material) {
      if (id === node.id) continue;
      const rem = index.byId.get(id);
      if (rem && hasSubstance(rem)) notes += 1;
      own.push(...(cardsByNode.get(id) ?? []));
    }
    const due = own.filter((c) => c.dueAt <= now).length;
    const fresh = own.filter((c) => c.lastReviewedAt === null).length;
    const mastered = own.length > 0 && own.every((c) => c.lastReviewedAt !== null && c.intervalDays >= MASTERED_DAYS);
    const status: PointStatus = mastered
      ? 'mastered'
      : own.length > 0
        ? fresh === 0
          ? 'learning'
          : 'cards'
        : notes > 0
          ? 'notes'
          : 'todo';
    return { id: node.id, text: node.plainText.trim(), status, notes, cards: own.length, due, fresh };
  };

  const units: UnitProgress[] = [];
  let skills: Roadmap['skills'] = null;

  for (const top of index.children.get(pageId) ?? []) {
    if (!isHeadingRem(top)) continue;
    const text = top.plainText.trim();
    const unitMatch = UNIT_TEXT.exec(text);
    if (unitMatch) {
      const areas: AreaProgress[] = [];
      const unitDescription: string[] = [];
      for (const child of index.children.get(top.id) ?? []) {
        const areaMatch = isHeadingRem(child) ? AREA_TEXT.exec(child.plainText.trim()) : null;
        if (!areaMatch) {
          if (!isHeadingRem(child) && child.plainText.trim()) unitDescription.push(child.plainText.trim());
          continue;
        }
        const { description, outcome, groups } = readGroups(child.id, index, pointOf);
        areas.push({
          id: child.id,
          number: Number(areaMatch[1]),
          title: areaMatch[2]!.trim(),
          description,
          outcome,
          groups,
          tally: tallyGroups(groups),
        });
      }
      const tally = emptyTally();
      for (const a of areas) add(tally, a.tally);
      units.push({ id: top.id, number: Number(unitMatch[1]), title: unitMatch[2]!.trim(), description: unitDescription, areas, tally });
    } else if (SKILLS_TEXT.test(text) && !skills) {
      const { groups } = readGroups(top.id, index, pointOf);
      skills = { id: top.id, groups, tally: tallyGroups(groups) };
    }
  }

  const tally = emptyTally();
  for (const u of units) add(tally, u.tally);

  let next: Roadmap['next'] = null;
  outer: for (const unit of units) {
    for (const area of unit.areas) {
      for (const group of area.groups) {
        const point = group.points.find((p) => !isStudied(p.status));
        if (point) {
          next = { point, unit, area };
          break outer;
        }
      }
    }
  }

  return { pageId, title: page.plainText.trim() || 'Untitled', units, skills, tally, next };
}
