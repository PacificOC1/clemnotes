import type { DocNode } from '../tiptap/docUtils';
import type { DraftRem } from '../db/treeInsert';
import { newInlineContext, parseInline, type InlineContext } from './inline';

/**
 * Markdown → rems.
 *
 * Built for the files people actually have: Obsidian and Logseq vaults,
 * notes exported from other apps, and Clemnotes' own Markdown export (which
 * this reads back as the pages it wrote). The mapping:
 *
 * - **Headings nest.** Everything under `## Methods` becomes children of a
 *   `Methods` rem, up to the next heading of the same or a higher level — so a
 *   long flat document arrives as an outline you can fold.
 * - **List items are rems**, nested by indentation; a line indented under an
 *   item continues that item.
 * - **Paragraphs, code blocks, quotes and tables** each become one rem.
 * - Inline syntax, links, tags, clozes and maths go through `parseInline`.
 * - **Images** (`![](path)`, `![[file.png]]`) become image rems once the
 *   importer has found the file; until then they carry their path.
 */

export interface ParsedPage {
  title: string;
  drafts: DraftRem[];
}

export interface ParseResult {
  pages: ParsedPage[];
  /** Every tag used anywhere, so their pages can be made. */
  tags: Set<string>;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(\s*)(```+|~~~+)\s*([\w+-]*)/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function indentOf(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

function paragraph(text: string, ctx: InlineContext): DocNode {
  const lines = text.split('\n');
  const content: DocNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    content.push(...parseInline(line, ctx));
  });
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
}

/** A line that is only an image, as a block; null for anything else. */
function imageBlock(text: string): DocNode | null {
  const md = /^!\[([^\]]*)\]\(<?([^)>]+?)>?(?:\s+"[^"]*")?\)$/.exec(text.trim());
  if (md) return { type: 'remImage', attrs: { imageId: null, alt: md[1] ?? '', size: 'full', src: md[2] } };
  const wiki = /^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(text.trim());
  if (wiki && IMAGE_EXT.test(wiki[1]!)) {
    return { type: 'remImage', attrs: { imageId: null, alt: '', size: 'full', src: wiki[1] } };
  }
  return null;
}

/** `![[Another note]]` — an embed. Without the target's id yet, a link is the honest translation. */
function embedAsLink(text: string): string {
  return text.replace(/!\[\[([^\]]+)\]\]/g, (_m, inner: string) => (IMAGE_EXT.test(inner.split('|')[0]!) ? `![[${inner}]]` : `[[${inner}]]`));
}

function textBlocks(text: string, ctx: InlineContext): DocNode[] {
  const image = imageBlock(text);
  if (image) return [image];
  return [paragraph(embedAsLink(text), ctx)];
}

function doc(blocks: DocNode[]): DocNode {
  return { type: 'doc', content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }] };
}

function tableBlock(lines: string[], ctx: InlineContext): DocNode {
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'));
  const [header = '', , ...body] = lines;
  const row = (line: string, cellType: 'tableHeader' | 'tableCell'): DocNode => ({
    type: 'tableRow',
    content: cells(line).map((cell) => ({ type: cellType, content: [paragraph(cell, ctx)] })),
  });
  return { type: 'table', content: [row(header, 'tableHeader'), ...body.map((l) => row(l, 'tableCell'))] };
}

interface Frontmatter {
  title?: string;
  tags: string[];
}

function readFrontmatter(lines: string[]): { meta: Frontmatter; rest: string[] } {
  const meta: Frontmatter = { tags: [] };
  if (lines[0]?.trim() !== '---') return { meta, rest: lines };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return { meta, rest: lines };
  let inTags = false;
  for (const line of lines.slice(1, end)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      inTags = false;
      const [, key, value = ''] = kv;
      if (key === 'title' && value.trim()) meta.title = value.trim().replace(/^["']|["']$/g, '');
      if (key === 'tags' || key === 'tag') {
        if (value.trim()) {
          meta.tags.push(
            ...value
              .replace(/^\[|\]$/g, '')
              .split(/[,\s]+/)
              .map((t) => t.replace(/^#/, '').replace(/^["']|["']$/g, ''))
              .filter(Boolean)
          );
        } else {
          inTags = true;
        }
      }
    } else if (inTags) {
      const item = /^\s*-\s*(.+)$/.exec(line);
      if (item) meta.tags.push(item[1]!.trim().replace(/^#/, '').replace(/^["']|["']$/g, ''));
    }
  }
  return { meta, rest: lines.slice(end + 1) };
}

/** Parse the body of one page (no frontmatter) into drafts. */
function parseBody(lines: string[], ctx: InlineContext): DraftRem[] {
  const root: DraftRem[] = [];
  const headings: Array<{ level: number; rem: DraftRem }> = [];
  let list: Array<{ indent: number; rem: DraftRem }> = [];
  let para: string[] = [];

  const container = () => (headings.length > 0 ? headings[headings.length - 1]!.rem.children! : root);
  const newRem = (blocks: DocNode[]): DraftRem => ({ doc: doc(blocks), children: [] });
  const appendBlocks = (rem: DraftRem, blocks: DocNode[]) => {
    const content = (rem.doc.content ?? []).filter((b) => !(b.type === 'paragraph' && !b.content?.length));
    rem.doc = { type: 'doc', content: [...content, ...blocks] };
  };

  const flushPara = () => {
    if (para.length === 0) return;
    const text = para.join('\n');
    para = [];
    container().push(newRem(textBlocks(text, ctx)));
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const indent = indentOf(line);
    const trimmed = line.trim();

    if (!trimmed) {
      flushPara();
      i += 1;
      continue;
    }

    // Code fence — at any indent; inside a list item it belongs to the item.
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[2]!;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim().startsWith(marker)) {
        body.push(lines[j]!.slice(Math.min(indent, indentOf(lines[j]!))));
        j += 1;
      }
      const block: DocNode = {
        type: 'codeBlock',
        attrs: { language: fence[3] || null },
        content: body.length > 0 ? [{ type: 'text', text: body.join('\n') }] : undefined,
      };
      const owner = list.length > 0 && indent > list[list.length - 1]!.indent ? list[list.length - 1]!.rem : null;
      if (owner) appendBlocks(owner, [block]);
      else {
        list = [];
        container().push(newRem([block]));
      }
      i = j + 1;
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flushPara();
      const [, , , checked, text = ''] = item;
      while (list.length > 0 && list[list.length - 1]!.indent >= indent) list.pop();
      const blocks =
        checked !== undefined
          ? [
              {
                type: 'taskList',
                content: [{ type: 'taskItem', attrs: { checked: checked.toLowerCase() === 'x' }, content: [paragraph(text, ctx)] }],
              },
            ]
          : textBlocks(text, ctx);
      const rem = newRem(blocks);
      (list.length > 0 ? list[list.length - 1]!.rem.children! : container()).push(rem);
      list.push({ indent, rem });
      i += 1;
      continue;
    }

    // An indented line under a list item continues it.
    if (list.length > 0 && indent > list[list.length - 1]!.indent) {
      const owner = list[list.length - 1]!.rem;
      const cont: string[] = [trimmed];
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() && indentOf(lines[j]!) > list[list.length - 1]!.indent && !LIST_ITEM.exec(lines[j]!) && !FENCE.exec(lines[j]!)) {
        cont.push(lines[j]!.trim());
        j += 1;
      }
      const heading = HEADING.exec(cont[0]!);
      if (heading && cont.length === 1) {
        appendBlocks(owner, [{ type: 'heading', attrs: { level: heading[1]!.length }, content: parseInline(heading[2]!, ctx) }]);
      } else {
        appendBlocks(owner, textBlocks(cont.join('\n'), ctx));
      }
      i = j;
      continue;
    }

    // Anything else at the margin ends the list.
    list = [];

    const heading = HEADING.exec(line);
    if (heading && indent < 4) {
      flushPara();
      const level = heading[1]!.length;
      while (headings.length > 0 && headings[headings.length - 1]!.level >= level) headings.pop();
      const rem = newRem([{ type: 'heading', attrs: { level: Math.min(level, 6) }, content: parseInline(heading[2]!, ctx) }]);
      container().push(rem);
      headings.push({ level, rem });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      flushPara();
      i += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushPara();
      const quoted: string[] = [];
      let j = i;
      while (j < lines.length && lines[j]!.trim().startsWith('>')) {
        quoted.push(lines[j]!.trim().replace(/^>\s?/, ''));
        j += 1;
      }
      container().push(newRem([{ type: 'blockquote', content: [paragraph(quoted.join('\n'), ctx)] }]));
      i = j;
      continue;
    }

    if (trimmed.startsWith('|') && TABLE_SEPARATOR.test(lines[i + 1] ?? '')) {
      flushPara();
      const rows: string[] = [];
      let j = i;
      while (j < lines.length && lines[j]!.trim().startsWith('|')) {
        rows.push(lines[j]!);
        j += 1;
      }
      container().push(newRem([tableBlock(rows, ctx)]));
      i = j;
      continue;
    }

    para.push(trimmed);
    i += 1;
  }
  flushPara();
  return root;
}

/** Everything needed to turn text into the title of a page. */
function titleOf(name: string): string {
  return name.replace(/^.*[\\/]/, '').replace(/\.(md|markdown|txt)$/i, '').trim() || 'Untitled';
}

/**
 * One file → one page (or, for a Clemnotes export, the pages it holds).
 * `ctx` is shared across files so tags from all of them are collected once.
 */
export function parseMarkdownFile(name: string, text: string, ctx = newInlineContext()): ParsedPage[] {
  const all = text.replace(/\r\n?/g, '\n').split('\n');

  // Clemnotes' own export: a header, a contents list, then `---`-separated
  // pages each opening with `# Title`.
  if (all.find((l) => l.trim())?.trim() === '# Clemnotes export') {
    const pages: ParsedPage[] = [];
    let chunk: string[] | null = null;
    const finish = () => {
      if (!chunk) return;
      const at = chunk.findIndex((l) => /^# /.test(l));
      if (at !== -1) {
        const title = chunk[at]!.replace(/^# /, '').trim() || 'Untitled';
        pages.push({ title, drafts: parseBody(chunk.slice(at + 1), { ...ctx, cloze: { next: 1 } }) });
      }
    };
    for (const line of all) {
      if (line.trim() === '---') {
        finish();
        chunk = [];
      } else if (chunk) {
        chunk.push(line);
      }
    }
    finish();
    return pages;
  }

  const { meta, rest } = readFrontmatter(all);
  let title = meta.title ?? titleOf(name);
  let body = rest;

  // A note that opens with its own `# Title` (and has no other H1) is titled
  // by it, rather than repeating it as the first rem.
  const firstIndex = body.findIndex((l) => l.trim());
  const first = firstIndex === -1 ? null : /^#\s+(.+)$/.exec(body[firstIndex]!.trim());
  const h1s = body.filter((l) => /^#\s/.test(l)).length;
  if (first && h1s === 1) {
    title = first[1]!.trim();
    body = body.slice(firstIndex + 1);
  }

  const drafts = parseBodyWithClozeReset(body, ctx);
  if (meta.tags.length > 0) {
    for (const tag of meta.tags) ctx.tags.add(tag);
    const content: DocNode[] = [];
    meta.tags.forEach((tag, i) => {
      if (i > 0) content.push({ type: 'text', text: ' ' });
      content.push({ type: 'tag', attrs: { title: tag, targetId: null } });
    });
    drafts.unshift({ doc: doc([{ type: 'paragraph', content }]), children: [] });
  }
  return [{ title, drafts }];
}

/**
 * Cloze numbers are per rem: each rem's blanks start again at 1. The shared
 * context keeps the tag set; the counter is reset for every rem made.
 */
function parseBodyWithClozeReset(lines: string[], ctx: InlineContext): DraftRem[] {
  const drafts = parseBody(lines, ctx);
  renumberClozes(drafts);
  return drafts;
}

function renumberClozes(drafts: DraftRem[]): void {
  for (const draft of drafts) {
    let next = 1;
    const walk = (node: DocNode): DocNode => {
      if (node.type === 'cloze') return { ...node, attrs: { ...node.attrs, index: next++ } };
      return node.content ? { ...node, content: node.content.map(walk) } : node;
    };
    draft.doc = walk(draft.doc);
    renumberClozes(draft.children ?? []);
  }
}

export function parseMarkdownFiles(files: Array<{ name: string; text: string }>): ParseResult {
  const ctx = newInlineContext();
  const pages = files.flatMap((file) => parseMarkdownFile(file.name, file.text, ctx));
  for (const page of pages) renumberClozes(page.drafts);
  return { pages, tags: ctx.tags };
}
