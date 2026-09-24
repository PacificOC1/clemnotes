import { beforeEach, describe, expect, it } from 'vitest';
import { countWords, countWordsIn, tableOfContents } from './outline';
import { createPage, deleteNode, updateContent } from './repository';
import { insertTree } from './treeInsert';
import { resetDatabase, textDoc, childOrder } from '../test/helpers';
import { docFromText, type DocNode } from '../tiptap/docUtils';

beforeEach(resetDatabase);

const heading = (level: number, text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] }],
});

describe('word count', () => {
  it('counts words, not punctuation, in any script', () => {
    expect(countWordsIn("It's a well-known fact — 3 cells, 日本 split.")).toBe(8);
    expect(countWordsIn('   ')).toBe(0);
  });

  it('adds up a rem and everything under it, ignoring deleted rems', async () => {
    const page = await createPage('Two words');
    await updateContent((await childOrder(page.id))[0]!, textDoc('three more words'), 'three more words');
    const { topIds } = await insertTree([{ doc: docFromText('gone soon') }], { parentId: page.id });
    expect(await countWords(page.id)).toBe(7);
    await deleteNode(topIds[0]!);
    expect(await countWords(page.id)).toBe(5);
  });
});

describe('table of contents', () => {
  it('lists heading rems in reading order, collapsed ones included', async () => {
    const page = await createPage('Notes');
    await insertTree(
      [
        { doc: heading(1, 'Introduction'), children: [{ doc: docFromText('plain') }] },
        { doc: heading(2, 'Details'), collapsed: true, children: [{ doc: heading(3, 'Deep') }] },
      ],
      { parentId: page.id }
    );
    expect((await tableOfContents(page.id)).map((e) => [e.level, e.text])).toEqual([
      [1, 'Introduction'],
      [2, 'Details'],
      [3, 'Deep'],
    ]);
  });
});
