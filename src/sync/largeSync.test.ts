import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/database';
import { createEmptyNode, type OutlinerNode, type ReviewLogEntry } from '../db/schema';
import { syncWithCloud } from './syncEngine';
import { forRemote } from './nodeMerge';
import { fakeSupabase, type CloudTables } from '../test/fakeSupabase';
import { resetDatabase, textDoc } from '../test/helpers';

/**
 * Tables bigger than one Supabase response. PostgREST returns at most
 * `max-rows` (1000 by default) per select, and one study-notes course alone is
 * several thousand rems — so these are the sizes real notes reach.
 */

const USER = '00000000-0000-0000-0000-000000000001';
const NOW = 1_800_000_000_000;

beforeEach(resetDatabase);

function makeNodes(count: number, updatedAt = NOW - 60_000): OutlinerNode[] {
  return Array.from({ length: count }, (_, i) => {
    const text = `Rem ${i}`;
    return {
      ...createEmptyNode(),
      id: `n-${String(i).padStart(5, '0')}`,
      content: textDoc(text),
      plainText: text,
      createdAt: updatedAt,
      updatedAt,
    } as OutlinerNode;
  });
}

function makeReviews(count: number): ReviewLogEntry[] {
  return Array.from({ length: count }, (_, i) => ({ id: `r-${i}`, updatedAt: NOW - 60_000, reviewedAt: NOW - 60_000 }) as unknown as ReviewLogEntry);
}

function cloudOf(nodes: OutlinerNode[]): CloudTables {
  return { nodes: new Map(nodes.map((n) => [n.id, { ...forRemote(n), userId: USER }])) };
}

describe('syncing tables bigger than one Supabase response', () => {
  it('a fresh browser gets back every rem, not just the first 1000', async () => {
    const nodes = makeNodes(2_500);
    const { client } = fakeSupabase({ ...cloudOf(nodes), reviews: new Map(makeReviews(1_200).map((r) => [r.id, { ...r, userId: USER }])) });

    await syncWithCloud(USER, NOW, client);

    expect(await db.nodes.count()).toBe(2_500);
    expect(await db.reviews.count()).toBe(1_200);
  });

  it('still gets everything when the project caps responses lower than our page size', async () => {
    const { client } = fakeSupabase(cloudOf(makeNodes(1_250)), { maxRows: 300 });

    await syncWithCloud(USER, NOW, client);

    expect(await db.nodes.count()).toBe(1_250);
  });

  it('uploads a big table in small requests', async () => {
    await db.nodes.bulkAdd(makeNodes(2_300));
    const { client, cloud, log } = fakeSupabase();

    await syncWithCloud(USER, NOW, client);

    expect(cloud.nodes!.size).toBe(2_300);
    const nodeUpserts = log.upserts.filter((u) => u.table === 'nodes');
    expect(nodeUpserts.length).toBeGreaterThan(1);
    expect(Math.max(...nodeUpserts.map((u) => u.rows))).toBeLessThanOrEqual(500);
  });

  it("never mistakes rems beyond the first page for ones the cloud purged", async () => {
    // Both sides agree on 1100 rems. Reading only the first 1000 used to make
    // the other 100 look purged by the cloud — and they were deleted here.
    const nodes = makeNodes(1_100, NOW - 2 * 24 * 60 * 60 * 1000);
    await db.nodes.bulkAdd(nodes);
    await db.syncBase.bulkPut(nodes.map((n) => ({ id: n.id, row: forRemote(n) })));
    const { client } = fakeSupabase(cloudOf(nodes));

    await syncWithCloud(USER, NOW, client);

    expect(await db.nodes.count()).toBe(1_100);
  });

  it('an incremental pull with more than a page of changes gets them all', async () => {
    const { client, cloud } = fakeSupabase(cloudOf(makeNodes(10)));
    await syncWithCloud(USER, NOW, client);

    // Another device adds 1500 rems after this one's last pull.
    for (const n of makeNodes(1_510, NOW + 120_000).slice(10)) cloud.nodes!.set(n.id, { ...forRemote(n), userId: USER });
    await syncWithCloud(USER, NOW + 180_000, client);

    expect(await db.nodes.count()).toBe(1_510);
  });
});
