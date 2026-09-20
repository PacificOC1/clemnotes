import { db } from '../db/database';
import { createEmptyNode, type Flashcard, type OutlinerNode } from '../db/schema';
import type { DocNode } from '../tiptap/docUtils';

/**
 * Shared scaffolding for the data-layer tests.
 *
 * The point of these helpers is that tests build notebooks the way the app
 * does — through the repository where a repository function exists — and drop
 * to raw `db.nodes.add` only for fixtures whose exact shape is the thing under
 * test. A test that hand-assembles state the app can never produce proves
 * nothing about the app.
 */

/** Empty every table. Call in `beforeEach`; tables are shared within a file. */
export async function resetDatabase(): Promise<void> {
  if (!db.isOpen()) await db.open();
  await Promise.all([
    db.nodes.clear(),
    db.cards.clear(),
    db.reviews.clear(),
    db.dictionary.clear(),
    db.folders.clear(),
  ]);
}

/** A one-paragraph Tiptap doc, as a stored `content` string. */
export function textDoc(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  } satisfies DocNode);
}

/** A doc containing `{{cloze}}` blanks at the given indices. */
export function clozeDoc(...clozes: Array<[index: number, text: string]>): string {
  const content: DocNode[] = [{ type: 'text', text: 'The answer is ' }];
  clozes.forEach(([index, text], i) => {
    content.push({ type: 'cloze', attrs: { index, text } });
    if (i < clozes.length - 1) content.push({ type: 'text', text: ' and ' });
  });
  return JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content }] } satisfies DocNode);
}

/** Insert a node directly, bypassing the repository. For fixtures only. */
export async function addNode(
  overrides: Partial<OutlinerNode> & { id: string }
): Promise<OutlinerNode> {
  const node = { ...createEmptyNode(), ...overrides } as OutlinerNode;
  await db.nodes.add(node);
  return node;
}

/** A node whose text is `text`, with `plainText` kept consistent with it. */
export async function addTextNode(
  id: string,
  text: string,
  overrides: Partial<OutlinerNode> = {}
): Promise<OutlinerNode> {
  return addNode({ id, content: textDoc(text), plainText: text, ...overrides });
}

/** Attach a child to a parent, keeping the parent's `childrenIds` mirror honest. */
export async function addChild(
  parent: OutlinerNode,
  id: string,
  text: string,
  overrides: Partial<OutlinerNode> = {}
): Promise<OutlinerNode> {
  const siblings = await db.nodes.where('parentId').equals(parent.id).toArray();
  const child = await addTextNode(id, text, {
    parentId: parent.id,
    order: (siblings.length + 1) * 1000,
    ...overrides,
  });
  const fresh = await db.nodes.get(parent.id);
  if (fresh) {
    await db.nodes.update(parent.id, { childrenIds: [...fresh.childrenIds, id] });
  }
  return child;
}

/** The ids of a node's live children, in display order. */
export async function childOrder(parentId: string): Promise<string[]> {
  const children = await db.nodes.where('parentId').equals(parentId).toArray();
  return children
    .filter((c) => !c.deletedAt)
    .sort((a, b) => a.order - b.order)
    .map((c) => c.id);
}

/** A card as it would be after `n` days of interval — for scheduling tests. */
export function cardLike(overrides: Partial<Flashcard> = {}): Flashcard {
  const now = Date.now();
  return {
    id: 'card-1',
    nodeId: 'node-1',
    kind: 'forward',
    clozeIndex: null,
    easeFactor: 2.5,
    interval: 0,
    repetitions: 0,
    lapses: 0,
    dueAt: now,
    lastReviewedAt: null,
    suspended: false,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
