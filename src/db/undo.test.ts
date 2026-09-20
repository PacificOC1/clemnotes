import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import {
  clearUndoHistory,
  onUndoChange,
  peekUndo,
  undoDepth,
  undoLast,
} from './undo';
import {
  createFirstChild,
  createPage,
  createSiblingAfter,
  deleteNode,
  deleteNodes,
  flattenVisible,
  getChildren,
  getNode,
  indentNode,
  indentNodes,
  mergeWithPreviousSibling,
  moveAmongSiblings,
  moveNodeRelativeTo,
  outdentNode,
} from './repository';
import { getCardsForNode, reconcileCards } from './cardRepository';
import { addChild, addTextNode, childOrder, resetDatabase, textDoc } from '../test/helpers';

async function threeChildTree() {
  const page = await addTextNode('page', 'Page', { isPage: true, order: 1000 });
  await addChild(page, 'a', 'A');
  await addChild(page, 'b', 'B');
  await addChild(page, 'c', 'C');
  return page;
}

beforeEach(async () => {
  await resetDatabase();
  clearUndoHistory();
});

describe('undoing a structural change', () => {
  it('puts an indent back', async () => {
    const page = await threeChildTree();
    await indentNode('b');
    expect(await childOrder(page.id)).toEqual(['a', 'c']);

    expect(await undoLast()).toBe('Indent');
    expect(await childOrder(page.id)).toEqual(['a', 'b', 'c']);
    expect(await childOrder('a')).toEqual([]);
    expect((await getNode('b'))?.parentId).toBe(page.id);
  });

  it('puts an outdent back', async () => {
    const page = await threeChildTree();
    await indentNode('b');
    clearUndoHistory();
    await outdentNode('b');

    await undoLast();
    expect(await childOrder('a')).toEqual(['b']);
    expect(await childOrder(page.id)).toEqual(['a', 'c']);
  });

  it('puts a reorder back', async () => {
    const page = await threeChildTree();
    await moveAmongSiblings('c', -1);
    expect(await childOrder(page.id)).toEqual(['a', 'c', 'b']);

    await undoLast();
    expect(await childOrder(page.id)).toEqual(['a', 'b', 'c']);
  });

  it('puts a drag back', async () => {
    const page = await threeChildTree();
    await moveNodeRelativeTo('c', 'a', 'child');
    expect(await childOrder('a')).toEqual(['c']);

    await undoLast();
    expect(await childOrder('a')).toEqual([]);
    expect(await childOrder(page.id)).toEqual(['a', 'b', 'c']);
  });

  it('brings a deleted rem back, with its subtree', async () => {
    const page = await threeChildTree();
    const grandchild = await createFirstChild('a');
    clearUndoHistory();

    await deleteNode('a');
    expect(await childOrder(page.id)).toEqual(['b', 'c']);

    expect(await undoLast()).toBe('Delete');
    expect(await childOrder(page.id)).toEqual(['a', 'b', 'c']);
    expect((await getNode(grandchild.id))?.deletedAt).toBeNull();
  });

  it('brings a deleted rem back with its cards, not a stripped copy', async () => {
    // Restoring the rems but not their scheduling would quietly reset months
    // of review history.
    const page = await threeChildTree();
    const rem = await addChild(page, 'card-rem', 'A :: B', { content: textDoc('A :: B') });
    await reconcileCards(rem);
    await db.cards.update('card-rem::forward', { interval: 30, repetitions: 4 });
    clearUndoHistory();

    await deleteNode('card-rem');
    expect(await getCardsForNode('card-rem')).toHaveLength(0);

    await undoLast();
    const [card] = await getCardsForNode('card-rem');
    expect(card).toMatchObject({ interval: 30, repetitions: 4 });
  });

  it('puts a merge back', async () => {
    const page = await threeChildTree();
    await mergeWithPreviousSibling('b');
    expect(await childOrder(page.id)).toEqual(['a', 'c']);

    await undoLast();
    expect(await childOrder(page.id)).toEqual(['a', 'b', 'c']);
    expect((await getNode('a'))?.plainText).toBe('A');
  });
});

describe('undoing a creation', () => {
  it('tombstones the new rem rather than removing the row', async () => {
    // A hard delete of something that has already synced just pulls it back
    // down on the next poll. A tombstone is how this app says "gone".
    const page = await threeChildTree();
    const fresh = await createSiblingAfter('a');
    expect(await childOrder(page.id)).toEqual(['a', fresh.id, 'b', 'c']);

    expect(await undoLast()).toBe('New rem');
    expect(await childOrder(page.id)).toEqual(['a', 'b', 'c']);
    const row = await db.nodes.get(fresh.id);
    expect(row).toBeDefined();
    expect(row?.deletedAt).toBeTypeOf('number');
  });

  it('takes back a new page and its first bullet', async () => {
    const created = await createPage('Fresh');
    const child = (await getChildren(created.id))[0];

    expect(await undoLast()).toBe('New page');
    expect((await db.nodes.get(created.id))?.deletedAt).toBeTypeOf('number');
    expect((await db.nodes.get(child!.id))?.deletedAt).toBeTypeOf('number');
  });
});

describe('a bulk operation is one undo', () => {
  it('counts as a single entry, whatever it touched', async () => {
    const page = await threeChildTree();
    clearUndoHistory();

    await deleteNodes(['a', 'b', 'c'], await flattenVisible(page.id));
    expect(undoDepth()).toBe(1);
    expect(peekUndo()?.label).toBe('Delete 3 rems');

    await undoLast();
    expect(await childOrder(page.id)).toEqual(['a', 'b', 'c']);
    expect(undoDepth()).toBe(0);
  });

  it('undoes a bulk indent in one step', async () => {
    const page = await threeChildTree();
    clearUndoHistory();

    await indentNodes(['b', 'c'], await flattenVisible(page.id));
    expect(undoDepth()).toBe(1);
    expect(await childOrder('a')).toEqual(['b', 'c']);

    await undoLast();
    expect(await childOrder(page.id)).toEqual(['a', 'b', 'c']);
    expect(await childOrder('a')).toEqual([]);
  });
});

describe('the stack itself', () => {
  it('unwinds several changes in order', async () => {
    const page = await threeChildTree();
    clearUndoHistory();

    await indentNode('b');
    await indentNode('c');
    expect(undoDepth()).toBe(2);

    await undoLast();
    expect(await childOrder(page.id)).toEqual(['a', 'c']);
    await undoLast();
    expect(await childOrder(page.id)).toEqual(['a', 'b', 'c']);
    expect(undoDepth()).toBe(0);
  });

  it('does nothing when there is nothing to undo', async () => {
    expect(await undoLast()).toBeNull();
  });

  it('does not make the undo itself undoable', async () => {
    await threeChildTree();
    clearUndoHistory();
    await indentNode('b');
    await undoLast();
    expect(undoDepth()).toBe(0);
  });

  it('tells anyone listening that it changed', async () => {
    await threeChildTree();
    clearUndoHistory();
    let calls = 0;
    const off = onUndoChange(() => { calls += 1; });

    await indentNode('b');
    expect(calls).toBe(1);
    await undoLast();
    expect(calls).toBe(2);

    off();
    await indentNode('c');
    expect(calls).toBe(2);
  });

  it('records nothing for an operation that was refused', async () => {
    await threeChildTree();
    clearUndoHistory();
    // `a` is the first child, so there is nothing to indent it under.
    expect(await indentNode('a')).toBe(false);
    expect(undoDepth()).toBe(0);
  });
});
