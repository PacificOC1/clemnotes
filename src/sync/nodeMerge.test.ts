import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/database';
import { createEmptyNode, type OutlinerNode } from '../db/schema';
import { forRemote, recordAgreed, resolveNodeConflicts } from './nodeMerge';
import { threeWayMerge } from './merge';
import { getVersions } from '../db/versionRepository';
import { resetDatabase, textDoc } from '../test/helpers';
import { createPage, deleteNode, getAllPages, indentNode, createSiblingAfter, outdentNode } from '../db/repository';
import { undoLast } from '../db/undo';

beforeEach(async () => {
  await resetDatabase();
  await db.syncBase.clear();
});

const rem = (text: string, extra: Partial<OutlinerNode> = {}): OutlinerNode =>
  ({ ...createEmptyNode(), id: 'r', content: textDoc(text), plainText: text, parentId: 'p1', order: 1, updatedAt: 100, ...extra }) as OutlinerNode;
const cursor = { pushedThrough: 150, pulledThrough: 150 };

describe('three-way merge', () => {
  it('keeps each side’s change when they touched different fields', () => {
    const base = rem('old');
    const local = { ...base, content: textDoc('edited'), plainText: 'edited', updatedAt: 200 };
    const remote = { ...base, parentId: 'p2', order: 5, updatedAt: 300 };
    const { row, contentConflict } = threeWayMerge(base, local, remote, [['content', 'plainText']]);
    expect(row).toMatchObject({ plainText: 'edited', parentId: 'p2', order: 5, updatedAt: 301 });
    expect(contentConflict).toBe(false);
  });

  it('falls back to the newer side when both changed the same field', () => {
    const base = rem('old');
    const local = { ...base, content: textDoc('mine'), plainText: 'mine', updatedAt: 200 };
    const remote = { ...base, content: textDoc('theirs'), plainText: 'theirs', updatedAt: 300 };
    const result = threeWayMerge(base, local, remote, [['content', 'plainText']]);
    expect(result.row.plainText).toBe('theirs');
    expect(result.contentConflict).toBe(true);
    expect(result.contentFrom).toBe('remote');
  });

  it('never splits content from what is derived from it', () => {
    const base = rem('old', { outboundLinks: [] });
    const local = { ...base, content: textDoc('link'), plainText: 'link', outboundLinks: ['x'], updatedAt: 200 };
    const remote = { ...base, outboundLinks: ['y'], updatedAt: 300 };
    const { row } = threeWayMerge(base, local, remote, [['content', 'plainText', 'outboundLinks']]);
    expect(row.outboundLinks).toEqual(['y']);
    expect(row.plainText).toBe('old');
  });
});

describe('resolving conflicts during sync', () => {
  it('merges an edit here with a move there, and plans it both ways', async () => {
    const base = rem('old');
    await recordAgreed([base]);
    const local = { ...base, content: textDoc('edited'), plainText: 'edited', updatedAt: 200 };
    const remote = { ...base, parentId: 'p2', updatedAt: 300 };
    const { plan, merged, kept } = await resolveNodeConflicts({ toUpload: [], toDownload: [remote] }, [local], [remote], cursor);
    expect(merged).toBe(1);
    expect(kept).toBe(0);
    expect(plan.toDownload).toHaveLength(1);
    expect(plan.toDownload[0]).toMatchObject({ plainText: 'edited', parentId: 'p2', updatedAt: 301 });
    expect(plan.toUpload[0]).toEqual(plan.toDownload[0]);
  });

  it('keeps the losing text when both sides edited it', async () => {
    const base = rem('old');
    await db.nodes.add(base);
    await recordAgreed([base]);
    const local = { ...base, content: textDoc('mine'), plainText: 'mine', updatedAt: 200 };
    const remote = { ...base, content: textDoc('theirs'), plainText: 'theirs', updatedAt: 300 };
    const { kept } = await resolveNodeConflicts({ toUpload: [], toDownload: [remote] }, [local], [remote], cursor);
    expect(kept).toBe(1);
    expect((await getVersions('r'))[0]).toMatchObject({ plainText: 'mine', reason: 'conflict', from: 'this device' });
  });

  it('keeps an edit that lost to a delete on the other device', async () => {
    const base = rem('old');
    await recordAgreed([base]);
    const local = { ...base, content: textDoc('late edit'), plainText: 'late edit', updatedAt: 200 };
    const remote = { ...base, deletedAt: 250, updatedAt: 250 };
    const { plan } = await resolveNodeConflicts({ toUpload: [local], toDownload: [] }, [local], [remote], cursor);
    expect(plan.toDownload[0]?.deletedAt).toBe(250);
    expect((await getVersions('r'))[0]?.plainText).toBe('late edit');
  });

  it('falls back to last-write-wins, keeping the loser, with no base', async () => {
    const local = rem('mine', { updatedAt: 200 });
    const remote = rem('theirs', { updatedAt: 300 });
    const input = { toUpload: [], toDownload: [remote] };
    const { plan, merged, kept } = await resolveNodeConflicts(input, [local], [remote], cursor);
    expect(merged).toBe(0);
    expect(kept).toBe(1);
    expect(plan).toBe(input);
  });

  it('strips the local-only index keys before anything leaves', () => {
    const row = { ...rem('x'), rootKey: 'page' as const, cardKey: 'card' as const };
    expect(Object.keys(forRemote(row))).not.toContain('rootKey');
    expect(Object.keys(forRemote(row))).not.toContain('cardKey');
  });
});

describe('the page index key', () => {
  it('follows every way a rem becomes or stops being a page', async () => {
    const page = await createPage('Top');
    const second = await createSiblingAfter(page.id);
    expect((await getAllPages()).map((p) => p.id)).toEqual([page.id, second.id]);

    await indentNode(second.id);
    expect((await db.nodes.get(second.id))?.rootKey).toBeUndefined();
    expect((await getAllPages()).map((p) => p.id)).toEqual([page.id]);

    await outdentNode(second.id);
    expect((await getAllPages()).map((p) => p.id)).toEqual([page.id, second.id]);

    await deleteNode(page.id);
    expect((await getAllPages()).map((p) => p.id)).toEqual([second.id]);

    await undoLast();
    expect((await getAllPages()).map((p) => p.id).sort()).toEqual([page.id, second.id].sort());
  });

  it('is derived for rows arriving from sync, whatever they carry', async () => {
    await db.nodes.bulkPut([
      { ...rem('synced page', { id: 'a', parentId: null, isPage: true }) },
      { ...rem('not a page', { id: 'b' }), rootKey: 'page' as const },
    ]);
    expect(await db.nodes.where('rootKey').equals('page').primaryKeys()).toEqual(['a']);
  });
});
