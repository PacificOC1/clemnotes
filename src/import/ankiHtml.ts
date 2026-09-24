import type { DocNode } from '../tiptap/docUtils';

/**
 * An Anki field (HTML) → Tiptap inline content, without a DOM.
 *
 * Anki fields are small, hand-edited HTML fragments, so a tokenizer with a
 * mark stack covers them: bold/italic/underline/strike/code/links, line
 * breaks, entities, images (returned separately — an image is a block here),
 * MathJax and `[latex]`, and cloze deletions, which may wrap formatting of
 * their own (`{{c1::<b>nucleus</b>}}`). Everything else — spans, fonts,
 * colours, sound tags — is dropped, keeping the text inside.
 */

type Mark = { type: string; attrs?: Record<string, unknown> };

export interface FieldContent {
  inline: DocNode[];
  images: string[];
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''));
}

const MARK_TAGS: Record<string, Mark> = {
  b: { type: 'bold' },
  strong: { type: 'bold' },
  i: { type: 'italic' },
  em: { type: 'italic' },
  u: { type: 'underline' },
  s: { type: 'strike' },
  strike: { type: 'strike' },
  del: { type: 'strike' },
  code: { type: 'code' },
};

const BREAK_BEFORE = new Set(['div', 'p', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// Private-use sentinels, so clozes and maths survive tokenising as text.
const OPEN = '';
const SEP = '';
const CLOSE = '';

/**
 * Parse one field. Cloze numbers come from Anki (`c1`, `c2` …), so a note's
 * cards line up with the blanks they test.
 */
export function fieldToInline(html: string): FieldContent {
  const images: string[] = [];

  let source = html
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (_m, n: string, text: string) => `${OPEN}C${n}${SEP}${stripTags(text)}${CLOSE}`)
    .replace(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\[\$\$?\]([\s\S]*?)\[\/\$\$?\]|\[latex\]([\s\S]*?)\[\/latex\]/gi, (_m, a?: string, b?: string, c?: string, d?: string) => `${OPEN}M${SEP}${stripTags(a ?? b ?? c ?? d ?? '')}${CLOSE}`);
  source = source.replace(/\r?\n/g, ' ');

  const out: DocNode[] = [];
  const marks: Mark[] = [];
  let pendingBreak = false;

  const pushText = (raw: string) => {
    const text = decodeEntities(raw);
    if (!text) return;
    if (pendingBreak && out.length > 0) out.push({ type: 'hardBreak' });
    pendingBreak = false;
    const parts = text.split(new RegExp(`${OPEN}([CM])(\\d*)${SEP}([^${CLOSE}]*)${CLOSE}`));
    for (let i = 0; i < parts.length; i++) {
      if (i % 4 === 0) {
        if (parts[i]) out.push(marks.length > 0 ? { type: 'text', text: parts[i], marks: marks.map((m) => ({ ...m })) } : { type: 'text', text: parts[i] });
        continue;
      }
      const kind = parts[i];
      const n = parts[i + 1];
      const body = (parts[i + 2] ?? '').trim();
      if (kind === 'C') out.push({ type: 'cloze', attrs: { index: Number(n) || 1, text: body } });
      else if (body) out.push({ type: 'math', attrs: { latex: body } });
      i += 2;
    }
  };

  const tag = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(source))) {
    pushText(source.slice(last, match.index));
    last = tag.lastIndex;
    const [, closing, rawName = '', attrs = ''] = match;
    const name = rawName.toLowerCase();

    if (name === 'br') {
      pendingBreak = true;
      continue;
    }
    if (name === 'img') {
      const src = /src\s*=\s*"([^"]*)"|src\s*=\s*'([^']*)'|src\s*=\s*([^\s>]+)/i.exec(attrs);
      const value = decodeEntities(src?.[1] ?? src?.[2] ?? src?.[3] ?? '');
      if (value) images.push(value);
      continue;
    }
    if (BREAK_BEFORE.has(name)) {
      if (out.length > 0) pendingBreak = true;
      continue;
    }
    const mark =
      name === 'a'
        ? { type: 'link', attrs: { href: decodeEntities(/href\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? '') } }
        : MARK_TAGS[name];
    if (!mark) continue;
    if (closing) {
      const at = marks.map((m) => m.type).lastIndexOf(mark.type);
      if (at !== -1) marks.splice(at, 1);
    } else if (mark.type !== 'link' || mark.attrs?.href) {
      marks.push(mark);
    }
  }
  pushText(source.slice(last));

  // Trim the edges: Anki fields often end in <br> or &nbsp;. Whitespace and
  // breaks can alternate at an edge, so repeat until nothing changes.
  let trimmed = out;
  for (;;) {
    const before = trimmed.length;
    const first = trimmed[0];
    if (first?.type === 'text') trimmed[0] = { ...first, text: first.text!.replace(/^\s+/, '') };
    const last = trimmed[trimmed.length - 1];
    if (last?.type === 'text') trimmed[trimmed.length - 1] = { ...last, text: last.text!.replace(/\s+$/, '') };
    trimmed = trimmed.filter((n) => n.type !== 'text' || n.text);
    while (trimmed[0]?.type === 'hardBreak') trimmed.shift();
    while (trimmed[trimmed.length - 1]?.type === 'hardBreak') trimmed.pop();
    if (trimmed.length === before) break;
  }

  return { inline: trimmed, images };
}
