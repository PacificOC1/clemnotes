/** A ProseMirror/Tiptap JSON document node — loosely typed since we only touch it structurally. */
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  content?: DocNode[];
}

export const EMPTY_DOC: DocNode = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

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
