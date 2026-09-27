import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createEmptyNode, type OutlinerNode } from './schema';
import { extractWikiLinks, parseDoc } from '../tiptap/docUtils';

/**
 * The v9 → current upgrade, run for real — snapshot first, as the app does.
 *
 * Every other test opens a database that is already at the current version, so
 * the upgrade functions never execute — which is exactly the code path that,
 * if it throws, leaves the app unable to open its own database on the next
 * load. This file builds a v9 database first and then opens the real one on
 * top of it.
 *
 * Nothing here may import `./database` at the top level: the module builds the
 * Dexie instance as a side effect of being imported, and it has to be imported
 * *after* the legacy database exists.
 */

const V9_STORES = {
  nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
  dictionary: 'id, word, updatedAt',
  folders: 'id, order, updatedAt',
  cards: 'id, nodeId, dueAt, updatedAt',
  reviews: 'id, cardId, nodeId, reviewedAt, updatedAt',
};

function legacyLinkDoc(title: string) {
  return JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See ' },
          // No `targetId` — this is what every link written before v10 looks like.
          { type: 'wikiLink', attrs: { title } },
        ],
      },
    ],
  });
}

function node(id: string, plainText: string, overrides: Partial<OutlinerNode> = {}): OutlinerNode {
  return { ...createEmptyNode(), id, plainText, ...overrides } as OutlinerNode;
}

const targetsOf = (content: string) => extractWikiLinks(parseDoc(content)).map((l) => l.targetId);

describe('upgrading a v9 database', () => {
  it('backfills link target ids and leaves everything else alone', async () => {
    const legacy = new Dexie('outliner-app-db');
    legacy.version(9).stores(V9_STORES);
    await legacy.open();
    expect(legacy.verno).toBe(9);

    await legacy.table('nodes').bulkAdd([
      // Rows from before #4 carry `childrenIds`; v15 drops it.
      { ...node('target', 'Photosynthesis', { isPage: true }), childrenIds: ['links'] } as OutlinerNode,
      node('links', 'See Photosynthesis', {
        content: legacyLinkDoc('Photosynthesis'),
        updatedAt: 1000,
      }),
      node('dangling', 'See Nowhere', { content: legacyLinkDoc('Nowhere'), updatedAt: 2000 }),
      node('plain', 'nothing to see', { updatedAt: 3000 }),
      node('clashing-clozes', 'two blanks, one number', {
        content: JSON.stringify({
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'cloze', attrs: { index: 1, text: 'alpha' } },
                { type: 'cloze', attrs: { index: 1, text: 'beta' } },
              ],
            },
          ],
        }),
        updatedAt: 4000,
      }),
    ]);
    // A card as every version before v16 stored it (#27).
    await legacy.table('cards').add({
      id: 'plain::forward', nodeId: 'plain', kind: 'forward', clozeIndex: null, easeFactor: 2.5, interval: 9,
      repetitions: 2, lapses: 0, dueAt: 5000, lastReviewedAt: 4000, suspended: false, deletedAt: null, createdAt: 1, updatedAt: 1,
    });
    legacy.close();

    // What `main.tsx` does before anything touches the database: copy it.
    const { snapshotBeforeUpgrade, listSnapshots, getSnapshot } = await import('./migrationSafety');
    const outcome = await snapshotBeforeUpgrade(16);
    expect(outcome.status).toBe('snapshotted');

    const { db } = await import('./database');
    await db.open();
    expect(db.verno).toBe(16);

    // The snapshot holds the rows as they were *before* v10 rewrote them.
    const [summary] = await listSnapshots();
    expect(summary).toMatchObject({ fromVersion: 9, toVersion: 16 });
    const before = await getSnapshot(summary!.id);
    const legacyLinks = (before!.tables.nodes as OutlinerNode[]).find((n) => n.id === 'links');
    expect(targetsOf(legacyLinks!.content)).toEqual([null]);

    // v12 adds the images table, v13 version history — both empty.
    expect(await db.images.count()).toBe(0);
    expect(await db.versions.count()).toBe(0);

    // v14 derives the page index key for rows already on disk.
    expect((await db.nodes.get('target'))?.rootKey).toBe('page');
    expect((await db.nodes.get('plain'))?.rootKey).toBeUndefined();
    expect(await db.nodes.where('rootKey').equals('page').primaryKeys()).toEqual(['target']);

    // v16: the interval says its unit (#27).
    const card = await db.cards.get('plain::forward');
    expect(card?.intervalDays).toBe(9);
    expect(card).not.toHaveProperty('interval');

    // v15: the title index (#15), and no more `childrenIds` (#4).
    expect(await db.nodes.where('titleKey').equals('photosynthesis').primaryKeys()).toEqual(['target']);
    expect(await db.nodes.get('target')).not.toHaveProperty('childrenIds');

    const linked = await db.nodes.get('links');
    expect(targetsOf(linked!.content)).toEqual(['target']);
    // A representation change is not an edit: bumping this would make every
    // device push its whole notebook on the next sync.
    expect(linked!.updatedAt).toBe(1000);

    const dangling = await db.nodes.get('dangling');
    expect(targetsOf(dangling!.content)).toEqual([null]);

    expect((await db.nodes.get('plain'))!.plainText).toBe('nothing to see');
    expect(await db.nodes.count()).toBe(5);

    // v11 runs in the same upgrade: the rem carrying two blanks on one number
    // comes out with them apart.
    const clashing = await db.nodes.get('clashing-clozes');
    const indices = [...(clashing?.content ?? '').matchAll(/"index":(\d+)/g)].map((m) => Number(m[1]));
    expect(indices).toEqual([1, 2]);

    db.close();
  });
});
