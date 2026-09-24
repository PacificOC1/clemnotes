import { beforeEach, describe, expect, it } from 'vitest';
import { parseInline, newInlineContext } from './inline';
import { parseMarkdownFile, parseMarkdownFiles } from './markdown';
import { importMarkdownFiles } from './importMarkdown';
import { docToPlainText, extractTags, extractWikiLinks, parseDoc, type DocNode } from '../tiptap/docUtils';
import type { DraftRem } from '../db/treeInsert';
import { resetDatabase } from '../test/helpers';
import { getAllPages, getChildren, getNode } from '../db/repository';
import { getAllFolders } from '../db/folderRepository';
import { getCardsForNode } from '../db/cardRepository';
import { getImage } from '../db/imageRepository';
import { buildExportTrees } from '../export/tree';
import { pagesToMarkdown } from '../export/markdown';
import { insertTree } from '../db/treeInsert';
import { createPage } from '../db/repository';

const text = (nodes: DocNode[]) => docToPlainText({ type: 'doc', content: [{ type: 'paragraph', content: nodes }] });
const outline = (drafts: DraftRem[], depth = 0): string[] =>
  drafts.flatMap((d) => [`${'  '.repeat(depth)}${docToPlainText(d.doc)}`, ...outline(d.children ?? [], depth + 1)]);

describe('inline syntax', () => {
  it('reads marks, links, tags, clozes and maths', () => {
    const ctx = newInlineContext();
    const nodes = parseInline('**Bold** and *it* with [[Target|alias]], #exam, {{blank}} and $x^2$', ctx);
    expect(nodes.find((n) => n.text === 'Bold')?.marks).toEqual([{ type: 'bold' }]);
    expect(nodes.find((n) => n.text === 'it')?.marks).toEqual([{ type: 'italic' }]);
    expect(nodes.find((n) => n.type === 'wikiLink')?.attrs).toMatchObject({ title: 'Target', alias: 'alias' });
    expect(nodes.find((n) => n.type === 'tag')?.attrs).toMatchObject({ title: 'exam' });
    expect(nodes.find((n) => n.type === 'cloze')?.attrs).toMatchObject({ index: 1, text: 'blank' });
    expect(nodes.find((n) => n.type === 'math')?.attrs).toMatchObject({ latex: 'x^2' });
    expect([...ctx.tags]).toEqual(['exam']);
  });

  it('leaves look-alikes as text', () => {
    expect(text(parseInline('snake_case_name costs $5 and $10, C# and issue #42'))).toBe(
      'snake_case_name costs $5 and $10, C# and issue #42'
    );
    expect(text(parseInline('a \\*literal\\* star'))).toBe('a *literal* star');
  });

  it('keeps code untouched', () => {
    const [code] = parseInline('`**not bold** [[nor a link]]`');
    expect(code).toMatchObject({ text: '**not bold** [[nor a link]]', marks: [{ type: 'code' }] });
  });

  it('reads links and nested emphasis', () => {
    const nodes = parseInline('see [the docs](https://example.com) and ***both***');
    expect(nodes.find((n) => n.text === 'the docs')?.marks).toEqual([{ type: 'link', attrs: { href: 'https://example.com' } }]);
    expect(text(nodes)).toBe('see the docs and both');
  });
});

describe('blocks', () => {
  it('nests content under headings and list items under list items', () => {
    const [page] = parseMarkdownFile(
      'Cell biology.md',
      ['## Organelles', '- Mitochondria', '  - makes ATP', '- Nucleus', '', '## Membranes', 'A paragraph', 'on two lines'].join('\n')
    );
    expect(page!.title).toBe('Cell biology');
    expect(outline(page!.drafts)).toEqual([
      'Organelles',
      '  Mitochondria',
      '    makes ATP',
      '  Nucleus',
      'Membranes',
      '  A paragraphon two lines',
    ]);
  });

  it('takes the title from a lone H1, and tags from frontmatter', () => {
    const [page] = parseMarkdownFile('note.md', ['---', 'tags: [bio, exam]', '---', '# Real title', 'body'].join('\n'));
    expect(page!.title).toBe('Real title');
    expect(extractTags(page!.drafts[0]!.doc).map((t) => t.title)).toEqual(['bio', 'exam']);
  });

  it('keeps code blocks, quotes, tables and tasks as rems', () => {
    const [page] = parseMarkdownFile(
      'x.md',
      ['```ts', 'const a = 1;', '```', '> quoted', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '- [x] done', '- [ ] todo'].join('\n')
    );
    const types = page!.drafts.map((d) => d.doc.content?.[0]?.type);
    expect(types).toEqual(['codeBlock', 'blockquote', 'table', 'taskList', 'taskList']);
    expect(page!.drafts[3]!.doc.content?.[0]?.content?.[0]?.attrs).toEqual({ checked: true });
  });

  it('continues a list item with its indented lines', () => {
    const [page] = parseMarkdownFile('x.md', ['- Question ::', '  second paragraph', '  - child'].join('\n'));
    const [item] = page!.drafts;
    expect(item!.doc.content).toHaveLength(2);
    expect(outline(item!.children ?? [])).toEqual(['child']);
  });

  it('numbers clozes from 1 in every rem', () => {
    const [page] = parseMarkdownFile('x.md', ['- {{a}} and {{b}}', '- {{c}}'].join('\n'));
    const indices = page!.drafts.map((d) => JSON.stringify(d.doc).match(/"index":\d/g));
    expect(indices).toEqual([['"index":1', '"index":2'], ['"index":1']]);
  });

  it('turns image lines into image placeholders and note embeds into links', () => {
    const [page] = parseMarkdownFile('x.md', ['![[diagram.png]]', '', '![[Other note]]'].join('\n'));
    expect(page!.drafts[0]!.doc.content?.[0]).toMatchObject({ type: 'remImage', attrs: { src: 'diagram.png' } });
    expect(extractWikiLinks(page!.drafts[1]!.doc)[0]?.title).toBe('Other note');
  });
});

describe('importing', () => {
  beforeEach(resetDatabase);

  const file = (path: string, body: BlobPart, type = 'text/markdown') => ({ path, file: new Blob([body], { type }) });

  it('makes linked pages in a folder, with cards, tag pages and images', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const report = await importMarkdownFiles(
      [
        file('Vault/Alpha.md', '- Links to [[Beta]] #topic\n- Term :: definition\n- ![[pic.png]]\n- ![[gone.png]]'),
        file('Vault/Beta.md', 'Plain page'),
        file('Vault/attachments/pic.png', png, 'image/png'),
      ],
      'Vault'
    );
    expect(report).toMatchObject({ pages: 2, images: 1, missingImages: ['gone.png'], tags: 1, folder: 'Vault' });

    const pages = await getAllPages();
    const alpha = pages.find((p) => p.plainText === 'Alpha')!;
    const beta = pages.find((p) => p.plainText === 'Beta')!;
    const topic = pages.find((p) => p.plainText === 'topic')!;
    const [linkRem, cardRem, imageRem] = await getChildren(alpha.id);
    expect(linkRem!.outboundLinks.sort()).toEqual([beta.id, topic.id].sort());
    expect(await getCardsForNode(cardRem!.id)).toHaveLength(1);
    const imageId = parseDoc(imageRem!.content).content?.[0]?.attrs?.imageId as string;
    expect([...new Uint8Array((await getImage(imageId))!.data)]).toEqual([...png]);

    const folders = await getAllFolders();
    expect(folders.find((f) => f.name === 'Vault')?.pageIds.sort()).toEqual([alpha.id, beta.id].sort());
    expect(folders.find((f) => f.name === 'Tags')?.pageIds).toEqual([topic.id]);
  });

  it('reads its own Markdown export back as the pages it wrote', async () => {
    const page = await createPage('Round trip');
    await insertTree(
      [
        { doc: parseDoc(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }, { type: 'text', text: ' :: answer' }] }] })), children: [{ doc: parseDoc(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A ' }, { type: 'cloze', attrs: { index: 1, text: 'blank' } }] }] })) }] },
      ],
      { parentId: page.id }
    );
    const exported = pagesToMarkdown(await buildExportTrees());
    const parsed = parseMarkdownFiles([{ name: 'export.md', text: exported }]);
    const roundTrip = parsed.pages.find((p) => p.title === 'Round trip')!;
    expect(outline(roundTrip.drafts)).toEqual(['', 'Bold :: answer', '  A blank']);
    expect(roundTrip.drafts[1]!.doc.content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'bold' }]);
    expect(JSON.stringify(roundTrip.drafts[1]!.children![0]!.doc)).toContain('"type":"cloze"');
    expect(await getNode(page.id)).toBeDefined();
  });
});
