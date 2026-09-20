/** A ProseMirror/Tiptap JSON document node — loosely typed since we only touch it structurally. */
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: DocNode[];
}

export const EMPTY_DOC: DocNode = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

/** The separator that turns a rem into a two-sided flashcard, RemNote-style. */
export const CARD_SEPARATOR = '::';

/** Parse a stored content string back into a doc; falls back to an empty doc if invalid/missing. */
export function parseDoc(content: string): DocNode {
  if (!content) return EMPTY_DOC;
  try {
    const parsed = JSON.parse(content);
    if (parsed && parsed.type === 'doc') return parsed;
    return EMPTY_DOC;
  } catch {
    return EMPTY_DOC;
  }
}

/** Extract plain, readable text from a doc — used for search, backlink snippets, titles, sidebar labels. */
export function docToPlainText(doc: DocNode): string {
  const parts: string[] = [];

  function walk(node: DocNode) {
    if (node.type === 'text' && node.text) {
      parts.push(node.text);
    } else if (node.type === 'wikiLink') {
      // The alias is what the sentence actually reads as, so it is what the
      // rem's plain text — search, titles, card faces — should contain.
      const label = node.attrs?.alias || node.attrs?.title;
      if (label) parts.push(String(label));
    } else if (node.type === 'math' && node.attrs?.latex) {
      parts.push(String(node.attrs.latex));
    } else if (node.type === 'cloze' && node.attrs?.text) {
      parts.push(String(node.attrs.text));
    }
    node.content?.forEach(walk);
  }

  walk(doc);
  return parts.join('').trim();
}

/** One `[[Title]]` as stored: the id it points at, and the text it was written as. */
export interface WikiLinkRef {
  /** The rem this link points at, when it was inserted from the picker. */
  targetId: string | null;
  /** What the link was written as — the fallback for a hand-typed link. */
  title: string;
  /** `[[Photosynthesis|it]]` — display text chosen by the writer, when there is one. */
  alias: string | null;
}

/**
 * Collect every `[[Title]]` in a doc.
 *
 * Links inserted from the `[[` picker carry the id of the rem they point at.
 * Links typed by hand — and every link written before ids existed — carry only
 * a title, and have to be resolved by matching text. Both shapes are here
 * because both will exist in any real notebook for a long time.
 */
export function extractWikiLinks(doc: DocNode): WikiLinkRef[] {
  const links: WikiLinkRef[] = [];

  function walk(node: DocNode) {
    if (node.type === 'wikiLink') {
      const title = node.attrs?.title === undefined ? '' : String(node.attrs.title);
      const rawId = node.attrs?.targetId;
      const targetId = typeof rawId === 'string' && rawId ? rawId : null;
      const rawAlias = node.attrs?.alias;
      const alias = typeof rawAlias === 'string' && rawAlias ? rawAlias : null;
      if (title || targetId) links.push({ targetId, title, alias });
    }
    node.content?.forEach(walk);
  }

  walk(doc);
  return links;
}

/** Just the titles, for the places that only care what a link reads as. */
export function extractWikiLinkTitles(doc: DocNode): string[] {
  return extractWikiLinks(doc)
    .map((link) => link.title)
    .filter(Boolean);
}

/**
 * Fill in `targetId` on any link that has none, using `resolve` to turn a
 * title into an id.
 *
 * Returns a new doc, or `null` when nothing changed — so a caller migrating a
 * whole table can write only the rows that actually needed it. A title that
 * resolves to nothing is left exactly as it was: an unresolvable link is not
 * broken, it is a link to a page that does not exist yet, and clicking it
 * still offers to create one.
 */
export function attachLinkTargets(
  doc: DocNode,
  resolve: (title: string) => string | undefined
): DocNode | null {
  let changed = false;

  function walk(node: DocNode): DocNode {
    let next = node;

    if (node.type === 'wikiLink' && !node.attrs?.targetId) {
      const title = node.attrs?.title === undefined ? '' : String(node.attrs.title);
      const targetId = title ? resolve(title) : undefined;
      if (targetId) {
        changed = true;
        next = { ...node, attrs: { ...node.attrs, targetId } };
      }
    }

    if (next.content) {
      const content = next.content.map(walk);
      if (content.some((child, i) => child !== next.content?.[i])) {
        next = { ...next, content };
      }
    }
    return next;
  }

  const result = walk(doc);
  return changed ? result : null;
}

/** True if a doc has no meaningful content (used for the Backspace-merge-when-empty check). */
export function isDocEmpty(doc: DocNode): boolean {
  return docToPlainText(doc).length === 0;
}

/** Wrap plain text into a single-paragraph doc. */
export function docFromText(text: string): DocNode {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  };
}

// ---------------------------------------------------------------------------
// Flashcard parsing
// ---------------------------------------------------------------------------

/** Every distinct {{cloze}} index present in a doc, ascending. */
export function extractClozeIndices(doc: DocNode): number[] {
  const indices = new Set<number>();

  function walk(node: DocNode) {
    if (node.type === 'cloze') {
      const raw = Number(node.attrs?.index ?? 1);
      indices.add(Number.isFinite(raw) ? raw : 1);
    }
    node.content?.forEach(walk);
  }

  walk(doc);
  return [...indices].sort((a, b) => a - b);
}

/**
 * Resolve duplicate cloze numbers in a sequence, in document order.
 *
 * Two blanks sharing a number share one card — so answering one silently
 * reschedules the other, and half the sentence is never really tested. Typing
 * blanks one at a time can't produce that, because each new one is numbered
 * past the highest; pasting a fragment from another rem, or splitting one rem
 * into two, produces it immediately.
 *
 * The rule is minimal churn, not tidiness. **Only duplicates move.** Gaps are
 * left alone — 1, 3, 7 works perfectly well, each blank has its own card, and
 * renumbering them to 1, 2, 3 would change every card's id and throw away the
 * scheduling attached to it. The first blank to claim a number keeps it, and
 * later claimants take the lowest number nobody is using.
 *
 * Returns `null` when nothing needs to move, so a caller can tell "already
 * fine" from "fixed" without comparing arrays.
 */
export function renumberedClozeIndices(indices: number[]): number[] | null {
  // Anything unusable counts as 1, which is what every reader of these already
  // does — and that mismatch is itself a bug worth writing back, not just a
  // tidy-up: the card is keyed on the coerced value while `renderCloze` matches
  // on the stored one, so a blank numbered 0 or NaN has a card that never
  // blanks anything.
  const clean = indices.map((raw) => (Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1));

  const keep = new Set<number>();
  for (const index of clean) keep.add(index);

  const claimed = new Set<number>();
  const taken = new Set<number>(keep);
  let changed = clean.some((value, i) => value !== indices[i]);

  const out = clean.map((index) => {
    if (!claimed.has(index)) {
      claimed.add(index);
      return index;
    }
    // Already spoken for: take the lowest number no blank is using, and that
    // no blank later in the sentence is going to want.
    let free = 1;
    while (taken.has(free)) free += 1;
    taken.add(free);
    changed = true;
    return free;
  });

  return changed ? out : null;
}

/**
 * Apply `renumberedClozeIndices` to a whole doc, in document order.
 *
 * Returns a new doc, or `null` when nothing needed to move — so a caller can
 * write only the rows that actually changed.
 */
export function renumberClozesInDoc(doc: DocNode): DocNode | null {
  const indices: number[] = [];
  function collect(node: DocNode) {
    if (node.type === 'cloze') indices.push(Number(node.attrs?.index ?? 1));
    node.content?.forEach(collect);
  }
  collect(doc);

  const renumbered = renumberedClozeIndices(indices);
  if (!renumbered) return null;

  let position = 0;
  function apply(node: DocNode): DocNode {
    let next = node;
    if (node.type === 'cloze') {
      const index = renumbered![position];
      position += 1;
      if (index !== undefined) next = { ...node, attrs: { ...node.attrs, index } };
    }
    if (next.content) next = { ...next, content: next.content.map(apply) };
    return next;
  }
  return apply(doc);
}

/** The highest cloze index in a doc — used to number the next one you create. */
export function maxClozeIndex(doc: DocNode): number {
  const indices = extractClozeIndices(doc);
  return indices.length === 0 ? 0 : indices[indices.length - 1]!;
}

export interface CardSides {
  front: DocNode;
  back: DocNode;
}

/**
 * Split a rem's doc on the first `::` into front and back docs, preserving
 * inline formatting, links and math on each side. Returns null when the rem
 * isn't a two-sided card. The split happens inside the first block, which is
 * where the separator lives in practice — any further blocks stay on the back.
 */
export function splitOnSeparator(doc: DocNode): CardSides | null {
  const blocks = doc.content ?? [];
  const first = blocks[0];
  if (!first?.content) return null;

  const inline = first.content;
  for (let i = 0; i < inline.length; i++) {
    const child = inline[i]!;
    if (child.type !== 'text' || !child.text?.includes(CARD_SEPARATOR)) continue;

    const at = child.text.indexOf(CARD_SEPARATOR);
    const beforeText = child.text.slice(0, at).replace(/\s+$/, '');
    const afterText = child.text.slice(at + CARD_SEPARATOR.length).replace(/^\s+/, '');

    const frontInline = inline.slice(0, i).map(cloneNode);
    if (beforeText) frontInline.push({ ...cloneNode(child), text: beforeText });

    const backInline: DocNode[] = [];
    if (afterText) backInline.push({ ...cloneNode(child), text: afterText });
    backInline.push(...inline.slice(i + 1).map(cloneNode));

    if (frontInline.length === 0 || backInline.length === 0) return null;

    return {
      front: { type: 'doc', content: [{ ...first, content: frontInline }] },
      back: { type: 'doc', content: [{ ...first, content: backInline }, ...blocks.slice(1).map(cloneNode)] },
    };
  }

  return null;
}

function cloneNode(node: DocNode): DocNode {
  return JSON.parse(JSON.stringify(node)) as DocNode;
}

/**
 * Render a doc for a cloze card: the cloze being tested becomes a blank (or,
 * once revealed, a highlighted answer) and every other cloze shows its text
 * normally. `revealed` controls which of those two the tested blank gets.
 */
export function renderCloze(doc: DocNode, index: number, revealed: boolean): DocNode {
  function walk(node: DocNode): DocNode {
    if (node.type === 'cloze') {
      const nodeIndex = Number(node.attrs?.index ?? 1);
      const text = String(node.attrs?.text ?? '');
      if (nodeIndex !== index) {
        return { type: 'text', text };
      }
      return {
        type: 'cloze',
        attrs: { index: nodeIndex, text, state: revealed ? 'revealed' : 'hidden' },
      };
    }
    if (node.content) {
      return { ...node, content: node.content.map(walk) };
    }
    return cloneNode(node);
  }

  return walk(doc);
}
