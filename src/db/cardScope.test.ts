import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import { buildPageIndex, countByPage, mapCardsToPages, scopeCards } from './cardScope';
import { getPageCardCounts, buildPracticeQueue, buildReviewQueue, reconcileCards } from './cardRepository';
import { DEFAULT_SETTINGS } from '../srs/settings';
import { addChild, addTextNode, cardLike, resetDatabase, textDoc } from '../test/helpers';
import { createEmptyNode, type OutlinerNode } from './schema';

function node(id: string, parentId: string | null, plainText = id): OutlinerNode {
  return { ...createEmptyNode(), id, parentId, plainText } as OutlinerNode;
}

describe('buildPageIndex', () => {
  it('maps every rem to the document it sits in', () => {
    const index = buildPageIndex([
      node('page', null),
      node('child', 'page'),
      node('grandchild', 'child'),
      node('other', null),
    ]);
    expect(index.get('page')).toBe('page');
    expect(index.get('child')).toBe('page');
    expect(index.get('grandchild')).toBe('page');
    expect(index.get('other')).toBe('other');
  });

  it('walks a deep chain without walking it once per leaf', () => {
    // Memoised, so this is a correctness check that doubles as the reason the
    // page is resolved rather than stored on every card.
    const nodes = [node('root', null)];
    for (let i = 1; i <= 200; i++) nodes.push(node(`n${i}`, i === 1 ? 'root' : `n${i - 1}`));
    const index = buildPageIndex(nodes);
    expect(index.get('n200')).toBe('root');
    expect(index.size).toBe(201);
  });

  it('keeps an orphan reachable rather than invisible', () => {
    // A row that arrived from sync before its ancestors, or whose parent was
    // hard-deleted, still has to land in some scope.
    const index = buildPageIndex([node('orphan', 'missing-parent')]);
    expect(index.get('orphan')).toBe('orphan');
  });

  it('does not hang on a parent cycle', () => {
    const index = buildPageIndex([node('a', 'b'), node('b', 'a')]);
    expect(index.get('a')).toBeTypeOf('string');
    expect(index.get('b')).toBeTypeOf('string');
  });

  it('handles an empty notebook', () => {
    expect(buildPageIndex([]).size).toBe(0);
  });
});

describe('scoping a set of cards', () => {
  const nodes = [node('maths', null), node('rem-a', 'maths'), node('history', null), node('rem-b', 'history')];
  const index = buildPageIndex(nodes);
  const cards = [
    cardLike({ id: 'c1', nodeId: 'rem-a' }),
    cardLike({ id: 'c2', nodeId: 'rem-a' }),
    cardLike({ id: 'c3', nodeId: 'rem-b' }),
  ];

  it('keeps only the cards from one document', () => {
    expect(scopeCards(cards, index, 'maths').map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(scopeCards(cards, index, 'history').map((c) => c.id)).toEqual(['c3']);
  });

  it('keeps everything when there is no scope', () => {
    expect(scopeCards(cards, index, null)).toHaveLength(3);
  });

  it('keeps nothing for a document with no cards', () => {
    expect(scopeCards(cards, index, 'nowhere')).toEqual([]);
  });

  it('counts per document', () => {
    expect([...countByPage(cards, index)]).toEqual([
      ['maths', 2],
      ['history', 1],
    ]);
  });

  it('reports which document each card belongs to', () => {
    expect(mapCardsToPages(cards, index).get('c3')).toBe('history');
  });
});

describe('scoped sessions', () => {
  beforeEach(resetDatabase);

  /** Two documents, one card each. */
  async function twoSubjects() {
    const maths = await addTextNode('maths', 'Maths', { isPage: true, order: 1 });
    const mathsRem = await addChild(maths, 'm1', 'Derivative :: rate of change', {
      content: textDoc('Derivative :: rate of change'),
    });
    const history = await addTextNode('history', 'History', { isPage: true, order: 2 });
    const historyRem = await addChild(history, 'h1', 'Magna Carta :: 1215', {
      content: textDoc('Magna Carta :: 1215'),
    });
    await reconcileCards(mathsRem);
    await reconcileCards(historyRem);
  }

  it('reviews only the document you asked for', async () => {
    await twoSubjects();
    const all = await buildReviewQueue(DEFAULT_SETTINGS);
    expect(all.queue).toHaveLength(2);

    const scoped = await buildReviewQueue(DEFAULT_SETTINGS, Date.now(), 'maths');
    expect(scoped.queue.map((c) => c.nodeId)).toEqual(['m1']);
  });

  it('scopes practice too, which is the point of it before an exam', async () => {
    await twoSubjects();
    expect(await buildPracticeQueue(40, 'history')).toHaveLength(1);
    expect(await buildPracticeQueue(40)).toHaveLength(2);
  });

  it('follows a rem that has been moved to another document', async () => {
    // Nothing is stored on the card, so a rem dragged from Maths into History
    // takes its cards with it — a stored page id would have gone stale here.
    await twoSubjects();
    await db.nodes.update('m1', { parentId: 'history' });
    expect((await buildReviewQueue(DEFAULT_SETTINGS, Date.now(), 'maths')).queue).toHaveLength(0);
    expect((await buildReviewQueue(DEFAULT_SETTINGS, Date.now(), 'history')).queue).toHaveLength(2);
  });

  it('counts cards per document for the picker, busiest first', async () => {
    await twoSubjects();
    const extra = await addChild(
      (await db.nodes.get('history'))!,
      'h2',
      'Hastings :: 1066',
      { content: textDoc('Hastings :: 1066') }
    );
    await reconcileCards(extra);

    const counts = await getPageCardCounts();
    expect(counts.map((c) => [c.title, c.due, c.total])).toEqual([
      ['History', 2, 2],
      ['Maths', 1, 1],
    ]);
  });

  it('leaves out documents with no cards at all', async () => {
    await twoSubjects();
    await addTextNode('empty', 'Shopping list', { isPage: true, order: 3 });
    expect((await getPageCardCounts()).map((c) => c.title)).not.toContain('Shopping list');
  });

  it('separates due from total', async () => {
    await twoSubjects();
    await db.cards.update('m1::forward', { dueAt: Date.now() + 86_400_000 });
    const maths = (await getPageCardCounts()).find((c) => c.title === 'Maths');
    expect(maths).toMatchObject({ due: 0, total: 1 });
  });
});
