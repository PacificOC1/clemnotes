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

/**
 * Ending a rem with this makes it a list card: "name everything underneath".
 * `Stages of mitosis >>>` asks for the rem's children, in order.
 */
export const LIST_MARKER = '>>>';

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
    } else if (node.type === 'tag' && node.attrs?.title) {
      parts.push(`#${String(node.attrs.title)}`);
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

/** One `#tag` as stored: the tag page it points at, and the name it was written as. */
export interface TagRef {
  targetId: string | null;
  title: string;
}

/**
 * Collect every `#tag` in a doc.
 *
 * A tag is mechanically a link — it points at a rem, the tag's page, and
 * lands in `outboundLinks` so the page can list everything tagged with it —
 * but it means something different. A link says "this is that"; a tag says
 * "this is about that". Keeping them as two node types is what lets the tag
 * page tell the two apart, and lets a query ask for one without the other.
 */
export function extractTags(doc: DocNode): TagRef[] {
  const tags: TagRef[] = [];
  function walk(node: DocNode) {
    if (node.type === 'tag') {
      const title = node.attrs?.title === undefined ? '' : String(node.attrs.title);
      const rawId = node.attrs?.targetId;
      const targetId = typeof rawId === 'string' && rawId ? rawId : null;
      if (title || targetId) tags.push({ targetId, title });
    }
    node.content?.forEach(walk);
  }
  walk(doc);
  return tags;
}

/**
 * Everything a doc points at — links and tags — as one list, which is what
 * `outboundLinks` stores. A tag carries no alias; it reads as its name.
 */
export function extractReferences(doc: DocNode): WikiLinkRef[] {
  return [
    ...extractWikiLinks(doc),
    ...extractTags(doc).map((tag) => ({ targetId: tag.targetId, title: tag.title, alias: null })),
  ];
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

/**
 * The first block's inline content with a trailing marker removed, or null
 * when the first block does not end with it.
 *
 * Only a *trailing* marker counts: `>>>` or `::` in the middle of a sentence is
 * prose (or, for `::`, the ordinary two-sided card), and at the end it is a
 * statement that the answer lives underneath.
 */
function stripTrailingMarker(doc: DocNode, marker: string): DocNode | null {
  const blocks = doc.content ?? [];
  const first = blocks[0];
  if (!first?.content || first.content.length === 0) return null;

  const inline = first.content.map(cloneNode);
  // Trailing whitespace-only text nodes don't count as the end of the sentence.
  while (inline.length > 0) {
    const last = inline[inline.length - 1]!;
    if (last.type === 'text' && !(last.text ?? '').trim()) inline.pop();
    else break;
  }
  const last = inline[inline.length - 1];
  if (!last || last.type !== 'text') return null;

  const text = (last.text ?? '').replace(/\s+$/, '');
  if (!text.endsWith(marker)) return null;

  const rest = text.slice(0, -marker.length).replace(/\s+$/, '');
  if (rest) inline[inline.length - 1] = { ...last, text: rest };
  else inline.pop();
  if (inline.length === 0) return null;

  return { type: 'doc', content: [{ ...first, content: inline }] };
}

/** `Stages of mitosis >>>` — the prompt of a list card, marker removed. */
export function splitListPrompt(doc: DocNode): DocNode | null {
  return stripTrailingMarker(doc, LIST_MARKER);
}

/**
 * `What does the liver do ::` with nothing after it — a card whose answer is
 * the rem's children rather than the rest of the line. Returns the question.
 *
 * The same card id as an ordinary `A :: B` card, so typing an answer onto the
 * line (or deleting it again) keeps the card and its scheduling.
 */
export function splitMultiLinePrompt(doc: DocNode): DocNode | null {
  if (splitOnSeparator(doc)) return null;
  return stripTrailingMarker(doc, CARD_SEPARATOR);
}

/**
 * Turn the children of a rem into one answer: a numbered list for a list card
 * ("name all of these" is usually asked in order), bullets otherwise.
 *
 * A list item's first child must be a paragraph, so a child whose first block
 * is a heading or a code block is flattened to a paragraph holding the same
 * inline content. Later blocks come through as they are.
 */
export function childrenAnswerDoc(children: DocNode[], ordered: boolean): DocNode {
  const items: DocNode[] = [];
  for (const child of children) {
    const blocks = (child.content ?? []).filter((b) => b.type !== 'remQuery');
    if (blocks.length === 0) continue;
    const [head, ...tail] = blocks;
    // Headings and code blocks hold inline content, so it moves across as is;
    // anything with block children (a table, a quote) is read out as text.
    const holdsInline = ['paragraph', 'heading', 'codeBlock'].includes(head!.type);
    const plain = docToPlainText({ type: 'doc', content: [head!] });
    const paragraph: DocNode = {
      type: 'paragraph',
      content: holdsInline ? head!.content?.map(cloneNode) : plain ? [{ type: 'text', text: plain }] : [],
    };
    if (!paragraph.content || paragraph.content.length === 0) continue;
    items.push({ type: 'listItem', content: [paragraph, ...tail.map(cloneNode)] });
  }

  if (items.length === 0) {
    return {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nothing underneath this rem yet.' }] }],
    };
  }
  return { type: 'doc', content: [{ type: ordered ? 'orderedList' : 'bulletList', content: items }] };
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

// ---------------------------------------------------------------------------
// Unlinked references
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A pattern for `title` as a whole phrase: not inside a longer word, so
 * "Cell" doesn't match "Cellular" and "RNA" doesn't match "mRNA".
 */
export function mentionPattern(title: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(title.trim())}(?![\\p{L}\\p{N}])`, 'iu');
}

/**
 * Turn the first plain mention of `title` in a doc into a link to `targetId`.
 *
 * Only inside ordinary text runs — never in code, and never across two runs
 * with different formatting, because a link can't straddle a bold boundary.
 * The link keeps the words as written (as its alias, when the casing
 * differs), so the sentence reads exactly as it did. Returns null when there
 * is no plain mention to link.
 */
export function linkFirstMention(doc: DocNode, title: string, targetId: string): DocNode | null {
  const pattern = mentionPattern(title);
  let done = false;

  function walk(node: DocNode): DocNode {
    if (done || node.type === 'codeBlock') return node;
    if (!node.content) return node;

    const content: DocNode[] = [];
    for (const child of node.content) {
      if (done || child.type !== 'text' || !child.text || child.marks?.some((m) => m.type === 'code')) {
        content.push(done ? child : walk(child));
        continue;
      }
      const match = pattern.exec(child.text);
      if (!match) {
        content.push(child);
        continue;
      }
      const before = child.text.slice(0, match.index);
      const written = match[0];
      const after = child.text.slice(match.index + written.length);
      if (before) content.push({ ...child, text: before });
      content.push({
        type: 'wikiLink',
        attrs: { title: title.trim(), targetId, alias: written === title.trim() ? null : written },
      });
      if (after) content.push({ ...child, text: after });
      done = true;
    }
    return { ...node, content };
  }

  const result = walk(doc);
  return done ? result : null;
}
