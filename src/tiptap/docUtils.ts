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
    } else if (node.type === 'wikiLink' && node.attrs?.title) {
      parts.push(String(node.attrs.title));
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

/** Collect every [[Title]] wikiLink node's title attr from a doc. */
export function extractWikiLinkTitles(doc: DocNode): string[] {
  const titles: string[] = [];

  function walk(node: DocNode) {
    if (node.type === 'wikiLink' && node.attrs?.title) {
      titles.push(String(node.attrs.title));
    }
    node.content?.forEach(walk);
  }

  walk(doc);
  return titles;
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
