import type { DocNode } from '../tiptap/docUtils';
import { TAG_CHARS } from '../db/tags';

/**
 * Markdown inline syntax → Tiptap inline nodes.
 *
 * Covers what notes actually use and what Clemnotes' own Markdown export
 * writes, so an export imports back as it went out: `**bold**`, `*italic*`,
 * `~~strike~~`, `==highlight==`, `<u>underline</u>`, `` `code` ``,
 * `[text](url)`, `[[Link]]` / `[[Link|alias]]`, `#tag` / `#[[multi word]]`,
 * `{{cloze}}`, `$maths$` and backslash escapes. Anything unrecognised is kept
 * as the text it was — an importer that drops what it doesn't understand is
 * worse than one that leaves it visible.
 */

type Mark = { type: string; attrs?: Record<string, unknown> };

interface Delimited {
  open: string;
  close: string;
  mark: Mark;
}

const DELIMITED: Delimited[] = [
  { open: '**', close: '**', mark: { type: 'bold' } },
  { open: '__', close: '__', mark: { type: 'bold' } },
  { open: '~~', close: '~~', mark: { type: 'strike' } },
  { open: '==', close: '==', mark: { type: 'highlight' } },
  { open: '<u>', close: '</u>', mark: { type: 'underline' } },
  { open: '*', close: '*', mark: { type: 'italic' } },
  { open: '_', close: '_', mark: { type: 'italic' } },
];

const TAG_AT = new RegExp(`^#(${TAG_CHARS}+)`, 'u');
const WORD_CHAR = /[\p{L}\p{N}]/u;
const ESCAPABLE = new Set('\\`*_{}[]()#+-.!|~=<>$'.split(''));

export interface InlineContext {
  /** Numbering for `{{clozes}}` within one rem; shared across its blocks. */
  cloze: { next: number };
  /** Every `#tag` seen, so the importer can make their pages. */
  tags: Set<string>;
}

export function newInlineContext(): InlineContext {
  return { cloze: { next: 1 }, tags: new Set() };
}

function withMarks(text: string, marks: Mark[]): DocNode {
  return marks.length > 0 ? { type: 'text', text, marks: marks.map((m) => ({ ...m })) } : { type: 'text', text };
}

/** Merge adjacent text nodes with identical marks, as ProseMirror would. */
function normalize(nodes: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (
      node.type === 'text' &&
      last?.type === 'text' &&
      JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])
    ) {
      out[out.length - 1] = { ...last, text: (last.text ?? '') + (node.text ?? '') };
    } else if (node.type !== 'text' || node.text) {
      out.push(node);
    }
  }
  return out;
}

export function parseInline(source: string, ctx: InlineContext = newInlineContext(), marks: Mark[] = []): DocNode[] {
  const out: DocNode[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) out.push(withMarks(buffer, marks));
    buffer = '';
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const ch = source[i]!;
    const prev = source[i - 1] ?? '';

    // Backslash escape: the next character is literal.
    if (ch === '\\' && ESCAPABLE.has(source[i + 1] ?? '')) {
      buffer += source[i + 1];
      i += 2;
      continue;
    }

    // `code` — nothing inside is parsed.
    if (ch === '`') {
      const fence = /^`+/.exec(rest)![0];
      const end = source.indexOf(fence, i + fence.length);
      if (end !== -1) {
        flush();
        const code = source.slice(i + fence.length, end).replace(/^ (.*) $/, '$1');
        out.push(withMarks(code, [...marks, { type: 'code' }]));
        i = end + fence.length;
        continue;
      }
    }

    // [[Link]] / [[Link|alias]]
    if (rest.startsWith('[[')) {
      const end = source.indexOf(']]', i + 2);
      if (end !== -1) {
        const inner = source.slice(i + 2, end);
        const [title = '', alias] = inner.split('|');
        if (title.trim()) {
          flush();
          out.push({
            type: 'wikiLink',
            attrs: { title: title.trim(), targetId: null, alias: alias?.trim() || null },
          });
          i = end + 2;
          continue;
        }
      }
    }

    // #[[multi word tag]]
    if (rest.startsWith('#[[') && !WORD_CHAR.test(prev)) {
      const end = source.indexOf(']]', i + 3);
      if (end !== -1) {
        const name = source.slice(i + 3, end).trim();
        if (name) {
          flush();
          ctx.tags.add(name);
          out.push({ type: 'tag', attrs: { title: name, targetId: null } });
          i = end + 2;
          continue;
        }
      }
    }

    // #tag — only at the start of a word, like the editor's own picker.
    if (ch === '#' && !WORD_CHAR.test(prev) && prev !== '&') {
      const match = TAG_AT.exec(rest);
      // Pure numbers (#1, #42) are almost always "number 1", not a tag.
      if (match && !/^\d+$/.test(match[1]!)) {
        flush();
        ctx.tags.add(match[1]!);
        out.push({ type: 'tag', attrs: { title: match[1]!, targetId: null } });
        i += match[0].length;
        continue;
      }
    }

    // {{cloze}}
    if (rest.startsWith('{{')) {
      const end = source.indexOf('}}', i + 2);
      if (end !== -1 && end > i + 2) {
        flush();
        out.push({ type: 'cloze', attrs: { index: ctx.cloze.next++, text: source.slice(i + 2, end) } });
        i = end + 2;
        continue;
      }
    }

    // $maths$ (and $$display$$, which a rem can only show inline anyway)
    if (ch === '$' && prev !== '\\') {
      const double = rest.startsWith('$$');
      const open = double ? 2 : 1;
      const end = source.indexOf(double ? '$$' : '$', i + open);
      const latex = end === -1 ? '' : source.slice(i + open, end);
      // "$5 and $10" is money: maths doesn't start or end with a space.
      if (end !== -1 && latex.trim() && (double || (!/^\s/.test(latex) && !/\s$/.test(latex)))) {
        flush();
        out.push({ type: 'math', attrs: { latex: latex.trim() } });
        i = end + open;
        continue;
      }
    }

    // [text](url)
    if (ch === '[') {
      const match = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (match) {
        flush();
        out.push(...parseInline(match[1]!, ctx, [...marks, { type: 'link', attrs: { href: match[2] } }]));
        i += match[0].length;
        continue;
      }
    }

    // Paired emphasis. `_` only at word boundaries, so snake_case stays text.
    let handled = false;
    for (const d of DELIMITED) {
      if (!rest.startsWith(d.open)) continue;
      if (d.open === '_' || d.open === '__') {
        if (WORD_CHAR.test(prev)) continue;
      }
      const after = source[i + d.open.length] ?? '';
      if (!after || /\s/.test(after)) continue;
      let end = source.indexOf(d.close, i + d.open.length + 1);
      // `*a **b** c*`: skip closers that are really the start of a longer run.
      while (end !== -1 && d.close === '*' && source[end + 1] === '*') {
        end = source.indexOf(d.close, end + 2);
      }
      // `***both***`: the bold closer is the *last* two stars of the run, so
      // the italic inside keeps its own.
      while (end !== -1 && d.close === '**' && source[end + 2] === '*') end += 1;
      if (end === -1 || /\s/.test(source[end - 1] ?? '')) continue;
      if ((d.close === '_' || d.close === '__') && WORD_CHAR.test(source[end + d.close.length] ?? '')) continue;
      flush();
      out.push(...parseInline(source.slice(i + d.open.length, end), ctx, [...marks, d.mark]));
      i = end + d.close.length;
      handled = true;
      break;
    }
    if (handled) continue;

    buffer += ch;
    i += 1;
  }
  flush();
  return normalize(out);
}
