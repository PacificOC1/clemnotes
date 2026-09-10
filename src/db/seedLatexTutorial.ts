import { v4 as uuid } from 'uuid';
import { db } from './database';
import { createEmptyNode, type OutlinerNode } from './schema';
import { docToPlainText, CARD_SEPARATOR, type DocNode } from '../tiptap/docUtils';
import { reconcileCards } from './cardRepository';
import { getAllPages } from './repository';
import { LATEX_COURSE, LATEX_COURSE_TITLE, type SeedRem } from './latexCourse';

/**
 * Installs the built-in "LaTeX in Clemnotes" course as a normal page of normal
 * rems — nothing here is a special node type, so the course can be edited,
 * moved, embedded, linked to and deleted like anything else the user wrote.
 *
 * The one thing this file is careful about is producing docs that are
 * *byte-identical in shape* to what the editor produces when you type the same
 * thing: a `math` node with a `latex` attr, a `cloze` node with `index`/`text`,
 * a `code`-marked text node. Anything else would render but wouldn't survive a
 * round-trip through the editor.
 *
 * See `latexCourse.ts` for the content and the little markup it is written in.
 */

/** Gap between adjacent order keys — matches repository.ts. */
const ORDER_STEP = 1000;

/**
 * One pass over the markup. The alternation is ordered so that a code span
 * wins at its own start position, which is what lets the course show a literal
 * `$` or a raw `\frac{a}{b}` without either being interpreted.
 */
const TOKEN = /`([^`]+)`|%([^%]+)%|\$([^$]+)\$|~([^~]+)~/g;

function textNode(text: string): DocNode {
  return { type: 'text', text };
}

function codeNode(text: string): DocNode {
  return { type: 'text', text, marks: [{ type: 'code' }] };
}

function mathNode(latex: string): DocNode {
  return { type: 'math', attrs: { latex } };
}

/**
 * Turn one row of markup into inline nodes.
 *
 * Cloze indices are assigned in document order starting at 1, which is what
 * the editor's own input rule produces (it numbers each new blank one past the
 * highest already in the rem) and what `extractClozeIndices` expects.
 */
function buildInline(text: string): DocNode[] {
  const out: DocNode[] = [];
  let cursor = 0;
  let clozeIndex = 0;

  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    if (match.index > cursor) out.push(textNode(text.slice(cursor, match.index)));

    const [whole, code, demo, math, cloze] = match;
    if (code !== undefined) {
      out.push(codeNode(code));
    } else if (demo !== undefined) {
      // `%x%` is the course's workhorse: show the source, then the result.
      out.push(codeNode(demo), textNode(' → '), mathNode(demo));
    } else if (math !== undefined) {
      out.push(mathNode(math));
    } else if (cloze !== undefined) {
      clozeIndex += 1;
      out.push({ type: 'cloze', attrs: { index: clozeIndex, text: cloze, state: null } });
    }

    cursor = match.index + whole.length;
  }

  if (cursor < text.length) out.push(textNode(text.slice(cursor)));
  return out;
}

function buildDoc(rem: SeedRem): DocNode {
  const inline = buildInline(rem.text);
  const block: DocNode = rem.heading
    ? { type: 'heading', attrs: { level: rem.heading }, content: inline }
    : { type: 'paragraph', content: inline };
  return { type: 'doc', content: [block] };
}

/** True when this rem's markup will make `cardRepository` generate cards for it. */
function producesCards(rem: SeedRem): boolean {
  return rem.text.includes('~') || rem.text.includes(CARD_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Authoring guardrails
// ---------------------------------------------------------------------------

/**
 * Catches the three authoring mistakes that would otherwise ship silently into
 * the user's notes, since none of them throws at render time:
 *
 * - a cloze and a `::` in one rem (cloze wins, so the `::` never splits and the
 *   separator shows up as literal text on the card);
 * - an unbalanced marker, which leaves a stray `` ` ``, `%`, `$` or `~` sitting
 *   in the rendered text;
 * - a `::` card with an empty side, which `splitOnSeparator` refuses, so the
 *   rem quietly generates no card at all.
 */
export function assertCourseIsValid(rems: SeedRem[] = LATEX_COURSE, path = 'root'): void {
  rems.forEach((rem, i) => {
    const where = `${path}[${i}]: ${JSON.stringify(rem.text.slice(0, 60))}`;
    const hasCloze = rem.text.includes('~');
    const hasSeparator = rem.text.includes(CARD_SEPARATOR);

    if (hasCloze && hasSeparator) {
      throw new Error(`${where} — mixes a cloze with "${CARD_SEPARATOR}"; cloze wins, so the card would never split.`);
    }
    if (rem.both && !hasSeparator) {
      throw new Error(`${where} — has both: true but no "${CARD_SEPARATOR}" to reverse.`);
    }
    if (hasSeparator) {
      const [front, ...rest] = rem.text.split(CARD_SEPARATOR);
      if (!front?.trim() || !rest.join(CARD_SEPARATOR).trim()) {
        throw new Error(`${where} — one side of the card is empty.`);
      }
    }

    // Any marker left in the plain-text remainder is an unbalanced pair.
    const plain = rem.text.replace(TOKEN, '');
    const stray = /[`%$~]/.exec(plain);
    if (stray) {
      throw new Error(`${where} — unbalanced "${stray[0]}" marker.`);
    }

    if (rem.children) assertCourseIsValid(rem.children, `${path}[${i}]`);
  });
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function buildRems(
  rems: SeedRem[],
  parentId: string,
  out: OutlinerNode[],
  cardNodeIds: string[]
): string[] {
  const ids: string[] = [];

  rems.forEach((rem, i) => {
    const id = uuid();
    const doc = buildDoc(rem);
    const node: OutlinerNode = {
      id,
      ...createEmptyNode({
        parentId,
        order: (i + 1) * ORDER_STEP,
        content: JSON.stringify(doc),
        plainText: docToPlainText(doc),
        collapsed: rem.collapsed ?? false,
        cardDirection: rem.both ? 'both' : 'forward',
      }),
    };

    out.push(node);
    ids.push(id);
    if (producesCards(rem)) cardNodeIds.push(id);

    if (rem.children && rem.children.length > 0) {
      node.childrenIds = buildRems(rem.children, id, out, cardNodeIds);
    }
  });

  return ids;
}

/** `LaTeX in Clemnotes`, `LaTeX in Clemnotes (2)`, … — whichever is free. */
function nextFreeTitle(pages: OutlinerNode[]): string {
  const taken = new Set(pages.map((p) => p.plainText.trim()));
  if (!taken.has(LATEX_COURSE_TITLE)) return LATEX_COURSE_TITLE;
  for (let n = 2; ; n += 1) {
    const candidate = `${LATEX_COURSE_TITLE} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface SeedResult {
  pageId: string;
  /** False when the course was already installed and `force` wasn't set. */
  created: boolean;
  title: string;
  remCount: number;
  cardCount: number;
}

/** The existing course page, if one is installed. */
export async function findLatexTutorialPage(): Promise<OutlinerNode | undefined> {
  const pages = await getAllPages();
  return pages.find((page) => page.plainText.trim() === LATEX_COURSE_TITLE);
}

/**
 * Create the course as a new top-level page.
 *
 * Returns `created: false` and the existing page when the course is already
 * installed, so the caller can offer to open it instead of quietly making a
 * second copy. Pass `force` to add another copy anyway — it gets a numbered
 * title, and its cards are independent of the first copy's.
 */
export async function seedLatexTutorial(options: { force?: boolean } = {}): Promise<SeedResult> {
  const existing = await findLatexTutorialPage();
  if (existing && !options.force) {
    return {
      pageId: existing.id,
      created: false,
      title: existing.plainText.trim(),
      remCount: 0,
      cardCount: 0,
    };
  }

  assertCourseIsValid();

  const pages = await getAllPages();
  const title = nextFreeTitle(pages);
  const lastOrder = pages.reduce((max, page) => Math.max(max, page.order), 0);

  const nodes: OutlinerNode[] = [];
  const cardNodeIds: string[] = [];

  const pageId = uuid();
  const pageDoc = buildDoc({ text: title });
  const page: OutlinerNode = {
    id: pageId,
    ...createEmptyNode({
      parentId: null,
      isPage: true,
      order: lastOrder + ORDER_STEP,
      content: JSON.stringify(pageDoc),
      plainText: title,
    }),
  };
  nodes.push(page);
  page.childrenIds = buildRems(LATEX_COURSE, pageId, nodes, cardNodeIds);

  const byId = new Map(nodes.map((node) => [node.id, node]));

  await db.transaction('rw', db.nodes, db.cards, async () => {
    await db.nodes.bulkAdd(nodes);
    // Only the rems that can actually produce cards — reconciling all ~140
    // would be a query each for nothing.
    for (const id of cardNodeIds) {
      const node = byId.get(id);
      if (node) await reconcileCards(node);
    }
  });

  const cards = await db.cards.where('nodeId').anyOf(cardNodeIds).toArray();

  return {
    pageId,
    created: true,
    title,
    remCount: nodes.length - 1,
    cardCount: cards.filter((card) => card.deletedAt === null).length,
  };
}
