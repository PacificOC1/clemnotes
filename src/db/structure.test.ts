import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import {
  createFirstChild,
  createSiblingAfter,
  deleteNode,
  findByTitle,
  getNode,
  indentNode,
  mergeWithPreviousSibling,
  moveNodeRelativeTo,
  outdentNode,
  searchNodesByTitle,
  updateContent,
} from './repository';
import { addChild, addTextNode, childOrder, resetDatabase } from '../test/helpers';
import { forRemote } from '../sync/nodeMerge';
import type { OutlinerNode } from './schema';

beforeEach(resetDatabase);

/** A doc with a hand-typed link: a title, no target id. */
function handTypedLink(title: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see ' }, { type: 'wikiLink', attrs: { title } }] }],
  });
}

async function tree() {
  const page = await addTextNode('page', 'Page', { isPage: true });
  const a = await addChild(page, 'a', 'Alpha');
  const b = await addChild(page, 'b', 'Beta');
  const c = await addChild(page, 'c', 'Gamma');
  return { page, a, b, c };
}

describe('one source of truth for the tree (#4)', () => {
  it('strips childrenIds from rows written by older versions — on add, put and update', async () => {
    const legacy = { ...(await addTextNode('x', 'X')), id: 'legacy', childrenIds: ['a'] } as OutlinerNode;
    await db.nodes.add(legacy);
    expect(await db.nodes.get('legacy')).not.toHaveProperty('childrenIds');

    // A row downloaded from an older device replaces one that exists here.
    await db.nodes.put({ ...legacy, plainText: 'X2' } as OutlinerNode);
    const put = await db.nodes.get('legacy');
    expect(put?.plainText).toBe('X2');
    expect(put).not.toHaveProperty('childrenIds');

    await db.nodes.bulkPut([{ ...legacy, plainText: 'X3' } as OutlinerNode]);
    expect(await db.nodes.get('legacy')).not.toHaveProperty('childrenIds');
  });

  it('never sends childrenIds to the cloud', () => {
    const row = { id: 'r', childrenIds: ['a'], rootKey: 'page', titleKey: 't' } as unknown as OutlinerNode;
    expect(forRemote(row)).toEqual({ id: 'r' });
  });

  it('moves rems without writing to the rows around them', async () => {
    const { page, a } = await tree();
    const stamp = async () => Object.fromEntries((await db.nodes.toArray()).map((n) => [n.id, n.updatedAt]));
    const before = await stamp();

    await indentNode('b'); // under a
    await outdentNode('b'); // back
    await moveNodeRelativeTo('c', 'a', 'before');
    const after = await stamp();

    // Only the rems that moved changed; their parents and siblings are untouched.
    expect(after.page).toBe(before.page);
    expect(after.a).toBe(before.a);
    expect(await childOrder(page.id)).toEqual(['c', 'a', 'b']);
    expect((await getNode(a.id))?.collapsed).toBe(false);
  });

  it('adding a child unfolds a folded parent without counting as an edit', async () => {
    const { a } = await tree();
    await db.nodes.update(a.id, { collapsed: true });
    const before = (await getNode(a.id))!.updatedAt;
    await createFirstChild(a.id);
    const after = await getNode(a.id);
    expect(after?.collapsed).toBe(false);
    expect(after?.updatedAt).toBe(before);
  });

  it('a new sibling lands right after its origin', async () => {
    const { page } = await tree();
    const fresh = await createSiblingAfter('a');
    expect(await childOrder(page.id)).toEqual(['a', fresh.id, 'b', 'c']);
  });

  it('merging hands the children over, after the ones already there, and the delete spares them', async () => {
    const { a, b } = await tree();
    await addChild(a, 'a1', 'a-one');
    await addChild(b, 'b1', 'b-one');
    await addChild(b, 'b2', 'b-two');
    await db.nodes.update(b.id, { content: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }), plainText: '' });

    expect(await mergeWithPreviousSibling(b.id)).toBe(a.id);
    expect(await childOrder(a.id)).toEqual(['a1', 'b1', 'b2']);
    expect((await getNode('b1'))?.deletedAt).toBeNull();
    expect((await getNode(b.id))?.deletedAt).toBeTypeOf('number');
  });

  it('deleting walks the tree through parentId', async () => {
    const { a } = await tree();
    await addChild(a, 'a1', 'deep');
    await deleteNode(a.id);
    expect((await getNode('a1'))?.deletedAt).toBeTypeOf('number');
  });
});

describe('titles through an index (#15)', () => {
  it('keeps titleKey in step with the text, and drops it on delete', async () => {
    await addTextNode('n', '  Cell Wall ');
    expect((await getNode('n'))?.titleKey).toBe('cell wall');
    await updateContent('n', JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Membrane' }] }] }), 'Membrane');
    expect((await getNode('n'))?.titleKey).toBe('membrane');
    await deleteNode('n');
    expect((await getNode('n'))?.titleKey).toBeUndefined();
  });

  it('leaves long text out of the title index', async () => {
    await addTextNode('long', 'x'.repeat(250));
    expect((await getNode('long'))?.titleKey).toBeUndefined();
  });

  it('resolves a title to a page before a bullet that reads the same', async () => {
    const page = await addTextNode('zzz-page', 'Osmosis', { isPage: true });
    await addChild(page, 'aaa-bullet', 'osmosis');
    expect((await findByTitle('OSMOSIS '))?.id).toBe('zzz-page');
  });

  it('resolves hand-typed links without reading the notebook', async () => {
    await addTextNode('target', 'Photosynthesis', { isPage: true });
    await addTextNode('src', 'see');
    for (let i = 0; i < 30; i++) await addTextNode(`filler-${i}`, `Filler ${i}`);
    const scanned: string[] = [];
    const hook = (row: OutlinerNode) => {
      scanned.push(row.id);
      return row;
    };
    // A full-table read would go through toArray on the whole table; the
    // title lookup goes through the titleKey index instead.
    db.nodes.hook('reading', hook);
    try {
      await updateContent('src', handTypedLink('photosynthesis'), 'see Photosynthesis');
    } finally {
      db.nodes.hook('reading').unsubscribe(hook);
    }
    expect((await getNode('src'))?.outboundLinks).toEqual(['target']);
    // It reads the rem being written and the match — not the thirty others.
    expect(scanned.filter((id) => id.startsWith('filler'))).toEqual([]);
  });

  it('the link picker puts the exact title first', async () => {
    await addTextNode('b1', 'Cell biology');
    await addTextNode('b2', 'Cell', { isPage: true });
    await addTextNode('b3', 'Cellular respiration');
    const found = await searchNodesByTitle('cell');
    expect(found[0]?.id).toBe('b2');
    expect(found.map((n) => n.id).sort()).toEqual(['b1', 'b2', 'b3']);
  });
});

describe('the one write path every row goes through', () => {
  it('strips childrenIds and derives keys on update and modify too', async () => {
    await addTextNode('u', 'Upd');
    await db.nodes.update('u', { childrenIds: ['z'], isPage: true } as Partial<OutlinerNode>);
    const updated = await db.nodes.get('u');
    expect(updated).not.toHaveProperty('childrenIds');
    expect(updated?.rootKey).toBe('page');

    await db.nodes.where('id').equals('u').modify((row) => {
      (row as unknown as Record<string, unknown>).childrenIds = ['y'];
      row.plainText = 'Modified';
    });
    const modified = await db.nodes.get('u');
    expect(modified).not.toHaveProperty('childrenIds');
    expect(modified?.titleKey).toBe('modified');
  });
});

describe('cards call it intervalDays (#27)', () => {
  it('turns a legacy `interval` into `intervalDays` on the way in — a backup, or an older device', async () => {
    const { cardLike } = await import('../test/helpers');
    const legacy = { ...cardLike({ id: 'old-card' }), interval: 12 } as Record<string, unknown>;
    delete legacy.intervalDays;
    await db.cards.put(legacy as never);
    const stored = await db.cards.get('old-card');
    expect(stored?.intervalDays).toBe(12);
    expect(stored).not.toHaveProperty('interval');

    // Both present (the cloud keeps both columns while devices update): intervalDays wins.
    await db.cards.put({ ...cardLike({ id: 'both' }), intervalDays: 5, interval: 3 } as never);
    expect((await db.cards.get('both'))?.intervalDays).toBe(5);
  });
});
