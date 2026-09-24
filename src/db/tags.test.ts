import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import { TAGS_FOLDER_NAME, ensureTagPage, findTagPages, normalizeTagName, searchTagPages } from './tags';
import { createPage, getBacklinks, getNode, updateContent } from './repository';
import { getAllFolders } from './folderRepository';
import { runQuery } from './query';
import { addTextNode, resetDatabase, childOrder } from '../test/helpers';
import { docToPlainText, extractReferences, extractTags, type DocNode } from '../tiptap/docUtils';
import { pagesToMarkdown } from '../export/markdown';
import { buildExportTrees } from '../export/tree';

beforeEach(resetDatabase);

function taggedDoc(text: string, tags: Array<{ title: string; targetId?: string | null }>): DocNode {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text },
          ...tags.flatMap((tag) => [
            { type: 'text', text: ' ' },
            { type: 'tag', attrs: { title: tag.title, targetId: tag.targetId ?? null } },
          ]),
        ],
      },
    ],
  };
}

/** Write a rem the way the editor does, through the one write path. */
async function write(id: string, doc: DocNode) {
  await addTextNode(id, '');
  await updateContent(id, JSON.stringify(doc), docToPlainText(doc));
}

describe('tag names', () => {
  it('drops the # and surrounding space', () => {
    expect(normalizeTagName('  ##exam ')).toBe('exam');
  });
});

describe('tag pages', () => {
  it('are made once, filed under Tags, and found case-insensitively', async () => {
    const id = await ensureTagPage('#Exam');
    expect(await ensureTagPage('exam')).toBe(id);
    expect((await getNode(id))?.plainText).toBe('Exam');
    expect((await findTagPages('EXAM')).map((p) => p.id)).toEqual([id]);

    const folders = await getAllFolders();
    expect(folders.map((f) => f.name)).toEqual([TAGS_FOLDER_NAME]);
    expect(folders[0]?.pageIds).toEqual([id]);
  });

  it('can be any page you already have', async () => {
    const page = await createPage('Biology');
    expect(await ensureTagPage('biology')).toBe(page.id);
  });

  it('are offered by prefix first, then by substring', async () => {
    await createPage('Anatomy');
    await createPage('Neuroanatomy');
    await createPage('Chemistry');
    expect((await searchTagPages('anat')).map((p) => p.plainText)).toEqual(['Anatomy', 'Neuroanatomy']);
  });
});

describe('tags in content', () => {
  it('are read out of a doc, and count as references', () => {
    const doc = taggedDoc('Krebs cycle', [{ title: 'exam', targetId: 't1' }]);
    expect(extractTags(doc)).toEqual([{ targetId: 't1', title: 'exam' }]);
    expect(extractReferences(doc).map((r) => r.targetId)).toEqual(['t1']);
  });

  it('read as #name in plain text, so search finds them', () => {
    expect(docToPlainText(taggedDoc('Krebs cycle', [{ title: 'exam' }]))).toBe('Krebs cycle #exam');
  });

  it('put the tag page in outboundLinks, so it lists what is tagged', async () => {
    const tagId = await ensureTagPage('exam');
    await write('rem', taggedDoc('Krebs cycle', [{ title: 'exam', targetId: tagId }]));
    expect((await getNode('rem'))?.outboundLinks).toEqual([tagId]);
    expect((await getBacklinks(tagId)).map((n) => n.id)).toEqual(['rem']);
  });

  it('export to Markdown as #name', async () => {
    const tagId = await ensureTagPage('exam');
    const page = await createPage('Notes');
    await db.nodes.update((await childOrder(page.id))[0]!, {
      content: JSON.stringify(taggedDoc('Krebs cycle', [{ title: 'exam', targetId: tagId }, { title: 'two words' }])),
    });
    const markdown = pagesToMarkdown(await buildExportTrees());
    expect(markdown).toContain('Krebs cycle #exam #[[two words]]');
  });
});

describe('querying by tag', () => {
  it('finds tagged rems and not rems that merely link to the tag page', async () => {
    const tagId = await ensureTagPage('exam');
    await write('tagged', taggedDoc('Tagged rem', [{ title: 'exam', targetId: tagId }]));
    await write('linked', {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Links to ' },
            { type: 'wikiLink', attrs: { title: 'exam', targetId: tagId } },
          ],
        },
      ],
    });

    const results = await runQuery({ tag: 'Exam' });
    expect(results.map((r) => r.node.id)).toEqual(['tagged']);
  });

  it('combines with text', async () => {
    const tagId = await ensureTagPage('exam');
    await write('a', taggedDoc('mitochondria', [{ title: 'exam', targetId: tagId }]));
    await write('b', taggedDoc('ribosome', [{ title: 'exam', targetId: tagId }]));
    expect((await runQuery({ tag: 'exam', text: 'ribosome' })).map((r) => r.node.id)).toEqual(['b']);
  });

  it('finds nothing for a tag nobody has made', async () => {
    expect(await runQuery({ tag: 'nothing' })).toEqual([]);
  });
});
