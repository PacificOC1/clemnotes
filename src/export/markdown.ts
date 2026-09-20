import { parseDoc, type DocNode } from '../tiptap/docUtils';
import type { OutlinerNode } from '../db/schema';

/**
 * Markdown export.
 *
 * The JSON backup is the lossless copy; this is the readable one — the format
 * you paste into Obsidian, hand to someone, or keep in a git repo. Where the
 * two disagree, this one optimises for reading.
 *
 * What survives, and why it matters:
 *
 * - **The outline shape.** Every rem is a bullet at its own depth, so the tree
 *   you built is the tree you get back.
 * - **`[[Links]]`** come out in the same syntax they went in, which is also
 *   what Obsidian and Logseq expect, so a link keeps working after the move.
 * - **Cards.** `Concept :: Descriptor` is literal text in the document, so it
 *   round-trips for free; clozes are re-rendered as `{{text}}`, the syntax
 *   that would recreate them. An exported page pasted back in makes the same
 *   cards it made before.
 * - **Maths** becomes `$latex$`.
 *
 * What is deliberately flattened: heading *blocks* inside a rem become bold
 * text, because a Markdown heading cannot live inside a list item without
 * breaking the list — and the list is the part worth keeping. Colours, font
 * sizes and text alignment have no Markdown to go to and are dropped.
 */

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Escape only what would actually be re-read as syntax.
 *
 * The tempting version of this escapes every character with a meaning in
 * Markdown, and produces `3\.5x \- 1 \(approx\)` — technically correct and
 * unreadable, which defeats the point of exporting to Markdown at all. So:
 *
 * - `` \ ` * [ ] `` are syntax anywhere and always get a backslash.
 * - `_` only opens emphasis at a word boundary — CommonMark ignores it inside
 *   a word — so `snake_case` is left alone while `_stressed_` is escaped.
 * - `!` only matters immediately before a link.
 * - Everything else (`. - # + > ( ) { }` and digits) is only syntax at the
 *   start of a line, and is handled there by `escapeLineStart`.
 */
function escapeText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '\\' || ch === '`' || ch === '*' || ch === '[' || ch === ']') {
      out += `\\${ch}`;
    } else if (ch === '_') {
      const inWord = WORD_CHAR.test(text[i - 1] ?? '') && WORD_CHAR.test(text[i + 1] ?? '');
      out += inWord ? '_' : '\\_';
    } else if (ch === '!' && text[i + 1] === '[') {
      out += '\\!';
    } else {
      out += ch;
    }
  }
  return out;
}

/** Line-leading syntax: a heading, a list marker, a quote or a thematic break. */
const LINE_START_SYNTAX = /^\s*(#{1,6}\s|[-+>]\s|\d+[.)]\s|-{3,}$|={3,}$)/;

/**
 * Neutralise a line that would be read as a block construct.
 *
 * Rem text starting "- " matters more here than it looks: every rem is itself
 * written as a bullet, so an unescaped one would nest a phantom list item
 * under its own rem.
 */
function escapeLineStart(line: string): string {
  return LINE_START_SYNTAX.test(line) ? line.replace(/^(\s*)/, '$1\\') : line;
}

interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}

/**
 * Wrap a run of text in its marks.
 *
 * `code` is applied last and swallows the rest: `**\`x\`**` renders, but the
 * emphasis inside a code span would be shown literally, which is never what
 * was meant.
 */
function applyMarks(text: string, marks: Mark[] | undefined): string {
  if (!marks || marks.length === 0) return escapeText(text);

  if (marks.some((m) => m.type === 'code')) {
    // Backticks inside the run need a longer fence.
    const longest = /`+/g.exec(text)?.[0].length ?? 0;
    const fence = '`'.repeat(longest + 1);
    const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${text}${pad}${fence}`;
  }

  let out = escapeText(text);
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        out = `**${out}**`;
        break;
      case 'italic':
        out = `*${out}*`;
        break;
      case 'strike':
        out = `~~${out}~~`;
        break;
      case 'underline':
        // No Markdown for it; the HTML tag is understood everywhere that matters.
        out = `<u>${out}</u>`;
        break;
      case 'highlight':
        out = `==${out}==`;
        break;
      case 'link': {
        const href = String(mark.attrs?.href ?? '');
        if (href) out = `[${out}](${href})`;
        break;
      }
      default:
        // textStyle (colour, font, size) and anything else: no Markdown equivalent.
        break;
    }
  }
  return out;
}

/** Render the inline children of a block. */
function inlineToMarkdown(nodes: DocNode[] | undefined): string {
  if (!nodes) return '';
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += applyMarks(node.text ?? '', node.marks);
        break;
      case 'wikiLink': {
        // `[[Target|as written]]` — both halves survive, because both are
        // syntax the importer can recreate.
        const target = String(node.attrs?.title ?? '');
        const alias = node.attrs?.alias ? String(node.attrs.alias) : '';
        out += alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
        break;
      }
      case 'math':
        out += `$${String(node.attrs?.latex ?? '')}$`;
        break;
      case 'cloze':
        // The syntax that would recreate this blank on import.
        out += `{{${String(node.attrs?.text ?? '')}}}`;
        break;
      case 'hardBreak':
        out += '\n';
        break;
      default:
        out += inlineToMarkdown(node.content);
        break;
    }
  }
  return out;
}

function tableToMarkdown(node: DocNode): string[] {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      // A cell holds blocks; flatten them onto one line, since a Markdown
      // table cell cannot contain a line break.
      (cell.content ?? [])
        .map((block) => inlineToMarkdown(block.content))
        .join(' ')
        .replace(/\|/g, '\\|')
        .trim()
    )
  );
  if (rows.length === 0) return [];

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (cells: string[]) => {
    const padded = [...cells];
    while (padded.length < width) padded.push('');
    return `| ${padded.join(' | ')} |`;
  };

  const [header, ...body] = rows;
  return [pad(header ?? []), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(pad)];
}

/**
 * Render one block to Markdown lines.
 *
 * Returns lines rather than a string because the caller has to indent them to
 * the rem's depth, and blocks that produce several lines (lists, code fences,
 * tables) have to be indented line by line.
 */
function blockToMarkdown(node: DocNode, listDepth = 0): string[] {
  const indent = '  '.repeat(listDepth);

  switch (node.type) {
    case 'paragraph': {
      const text = inlineToMarkdown(node.content);
      return text ? text.split('\n').map(escapeLineStart) : [''];
    }

    case 'heading': {
      // Flattened to bold — see the note at the top of this file.
      const text = inlineToMarkdown(node.content);
      return text ? [`**${text}**`] : [''];
    }

    case 'bulletList':
    case 'orderedList': {
      const ordered = node.type === 'orderedList';
      const start = Number(node.attrs?.start ?? 1);
      const lines: string[] = [];
      (node.content ?? []).forEach((item, i) => {
        const marker = ordered ? `${start + i}. ` : '- ';
        const inner = (item.content ?? []).flatMap((child) => blockToMarkdown(child, listDepth + 1));
        const [first = '', ...rest] = inner;
        lines.push(`${indent}${marker}${first}`);
        for (const line of rest) lines.push(line ? `${indent}  ${line}` : '');
      });
      return lines;
    }

    case 'taskList': {
      const lines: string[] = [];
      for (const item of node.content ?? []) {
        const checked = item.attrs?.checked === true;
        const inner = (item.content ?? []).flatMap((child) => blockToMarkdown(child, listDepth + 1));
        const [first = '', ...rest] = inner;
        lines.push(`${indent}- [${checked ? 'x' : ' '}] ${first}`);
        for (const line of rest) lines.push(line ? `${indent}  ${line}` : '');
      }
      return lines;
    }

    case 'blockquote':
      return (node.content ?? [])
        .flatMap((child) => blockToMarkdown(child, listDepth))
        .map((line) => (line ? `> ${line}` : '>'));

    case 'codeBlock': {
      const language = String(node.attrs?.language ?? '');
      const code = (node.content ?? []).map((c) => c.text ?? '').join('');
      return ['```' + language, ...code.split('\n'), '```'];
    }

    case 'horizontalRule':
      return ['---'];

    case 'table':
      return tableToMarkdown(node);

    default: {
      const text = inlineToMarkdown(node.content);
      return text ? [text] : [];
    }
  }
}

/** Render a whole rem document to Markdown lines. */
export function docToMarkdownLines(doc: DocNode): string[] {
  const lines = (doc.content ?? []).flatMap((block) => blockToMarkdown(block));
  // Trim trailing blank lines; a rem's own emptiness shouldn't leave gaps.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function docToMarkdown(doc: DocNode): string {
  return docToMarkdownLines(doc).join('\n');
}

/** A rem plus its children, as the exporter walks the tree. */
export interface ExportTreeNode {
  node: OutlinerNode;
  children: ExportTreeNode[];
  /** Set on a portal, so the export can name what it embeds. */
  portalTitle?: string;
}

/**
 * Render a rem subtree as a nested bullet list.
 *
 * A portal is written as `![[Target]]` — Obsidian's embed syntax, and the
 * closest honest translation. Following it into the target and inlining that
 * content would duplicate every embedded rem in the export and turn a portal
 * cycle into an infinite file.
 */
function treeToMarkdown(tree: ExportTreeNode, depth: number, out: string[]): void {
  const indent = '  '.repeat(depth);

  if (tree.node.isPortal) {
    out.push(`${indent}- ![[${tree.portalTitle ?? 'deleted rem'}]]`);
  } else {
    const lines = docToMarkdownLines(parseDoc(tree.node.content));
    const [first = '', ...rest] = lines;
    out.push(`${indent}- ${first}`);
    for (const line of rest) out.push(line ? `${indent}  ${line}` : '');
  }

  for (const child of tree.children) treeToMarkdown(child, depth + 1, out);
}

/**
 * Render a set of rems as bullets, each with its own subtree.
 *
 * Unlike `pageToMarkdown` this keeps the rem's own text as the first bullet
 * rather than promoting it to a heading: what is being copied is a fragment of
 * an outline, not a document, and it is going to be pasted inside something
 * else.
 */
export function remsToMarkdown(trees: ExportTreeNode[]): string {
  const out: string[] = [];
  for (const tree of trees) treeToMarkdown(tree, 0, out);
  return out.join('\n');
}

/**
 * Render one page: a `# Title` heading, then its subtree as bullets.
 *
 * The page rem's own content becomes the title, so it isn't repeated as the
 * first bullet.
 */
export function pageToMarkdown(page: ExportTreeNode): string {
  const title = page.node.plainText.trim() || 'Untitled';
  const out: string[] = [`# ${title}`, ''];
  for (const child of page.children) treeToMarkdown(child, 0, out);
  out.push('');
  return out.join('\n');
}

/**
 * Every page in one file, with a table of contents.
 *
 * One file rather than a zip because Clemnotes has no zip dependency and this
 * needs to keep working without one — and because a single file is what you
 * actually want when the point is to read or search the lot.
 */
export function pagesToMarkdown(pages: ExportTreeNode[], exportedAt = Date.now()): string {
  const date = new Date(exportedAt).toISOString().slice(0, 10);
  const out: string[] = [`# Clemnotes export`, '', `Exported ${date} · ${pages.length} page${pages.length === 1 ? '' : 's'}`, ''];

  if (pages.length > 1) {
    out.push('## Contents', '');
    for (const page of pages) {
      out.push(`- ${page.node.plainText.trim() || 'Untitled'}`);
    }
    out.push('');
  }

  for (const page of pages) {
    out.push('---', '');
    out.push(pageToMarkdown(page));
  }

  return out.join('\n');
}
