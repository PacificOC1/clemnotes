import { beforeEach, describe, expect, it } from 'vitest';
import { invalidateSearchIndex, searchNodes, warmSearchIndex } from './searchIndex';
import { deleteNode, updateContent } from './repository';
import { addChild, addTextNode, resetDatabase, textDoc } from '../test/helpers';

async function notebook() {
  const page = await addTextNode('page', 'Biology', { isPage: true, order: 1 });
  await addChild(page, 'a', 'Mitochondria make ATP');
  await addChild(page, 'b', 'Chloroplasts do photosynthesis');
  await addChild(page, 'c', '');
  return page;
}

beforeEach(async () => {
  await resetDatabase();
  invalidateSearchIndex();
});

describe('searching', () => {
  it('finds a rem by a word in it', async () => {
    await notebook();
    const hits = await searchNodes('mitochondria');
    expect(hits.map((h) => h.node.id)).toEqual(['a']);
  });

  it('matches on a prefix, not just whole words', async () => {
    await notebook();
    expect((await searchNodes('photo')).map((h) => h.node.id)).toEqual(['b']);
  });

  it('says which document each hit came from', async () => {
    const page = await notebook();
    const [hit] = await searchNodes('ATP');
    expect(hit?.sourcePage?.id).toBe(page.id);
  });

  it('returns nothing for an empty term', async () => {
    await notebook();
    expect(await searchNodes('   ')).toEqual([]);
  });

  it('leaves empty rems out', async () => {
    await notebook();
    expect((await searchNodes('')).length).toBe(0);
  });
});

describe('keeping the index in step', () => {
  it('finds text added after the index was built', async () => {
    await notebook();
    await warmSearchIndex();
    expect(await searchNodes('ribosome')).toEqual([]);

    await updateContent('c', textDoc('Ribosomes build proteins'), 'Ribosomes build proteins');
    expect((await searchNodes('ribosome')).map((h) => h.node.id)).toEqual(['c']);
  });

  it('stops finding text that was edited away', async () => {
    await notebook();
    await warmSearchIndex();
    await updateContent('a', textDoc('Something else entirely'), 'Something else entirely');

    expect(await searchNodes('mitochondria')).toEqual([]);
    expect((await searchNodes('entirely')).map((h) => h.node.id)).toEqual(['a']);
  });

  it('stops finding a deleted rem', async () => {
    await notebook();
    await warmSearchIndex();
    await deleteNode('b');
    expect(await searchNodes('photosynthesis')).toEqual([]);
  });

  it('drops a rem whose text was emptied', async () => {
    await notebook();
    await warmSearchIndex();
    await updateContent('a', textDoc(''), '');
    expect(await searchNodes('mitochondria')).toEqual([]);
  });

  it('rebuilds from the database after being invalidated', async () => {
    await notebook();
    await warmSearchIndex();
    invalidateSearchIndex();
    expect((await searchNodes('chloroplasts')).map((h) => h.node.id)).toEqual(['b']);
  });

  it('builds once when several searches race the first build', async () => {
    await notebook();
    const [one, two, three] = await Promise.all([
      searchNodes('ATP'),
      searchNodes('ATP'),
      searchNodes('photosynthesis'),
    ]);
    expect(one.map((h) => h.node.id)).toEqual(['a']);
    expect(two.map((h) => h.node.id)).toEqual(['a']);
    expect(three.map((h) => h.node.id)).toEqual(['b']);
  });
});
