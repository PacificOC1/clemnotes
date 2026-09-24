import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/database';
import { syncWithCloud } from './syncEngine';
import { fakeSupabase } from '../test/fakeSupabase';
import { addTextNode, resetDatabase } from '../test/helpers';
import { forRemote } from './nodeMerge';
import type { OutlinerNode } from '../db/schema';

const USER = '00000000-0000-0000-0000-000000000001';
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

beforeEach(resetDatabase);

function cloudRow(node: OutlinerNode) {
  return { ...forRemote(node), userId: USER };
}

describe('purging old deletions through sync (#24)', () => {
  it('a device that missed a delete *and* its purge deletes the rem instead of bringing it back', async () => {
    // Both sides once agreed on this rem; since then another device deleted
    // it, and more than 90 days later the cloud purged the tombstone.
    const stale = await addTextNode('stale', 'Deleted elsewhere long ago', { updatedAt: NOW - 200 * DAY });
    const keep = await addTextNode('keep', 'Still here', { updatedAt: NOW - 200 * DAY });
    await db.syncBase.bulkPut([{ id: 'stale', row: forRemote(stale) }, { id: 'keep', row: forRemote(keep) }]);
    const { client, cloud } = fakeSupabase({ nodes: new Map([['keep', cloudRow(keep)]]) });

    await syncWithCloud(USER, NOW, client);

    expect(await db.nodes.get('stale')).toBeUndefined();
    expect(cloud.nodes!.has('stale')).toBe(false);
    expect(await db.nodes.get('keep')).toBeDefined();
  });

  it('an edit made here after the delete wins, and goes back up', async () => {
    const base = await addTextNode('edited', 'old text', { updatedAt: NOW - 200 * DAY });
    await db.syncBase.put({ id: 'edited', row: forRemote(base) });
    await db.nodes.update('edited', { plainText: 'rewritten offline', updatedAt: NOW - 1 * DAY });
    const { client, cloud } = fakeSupabase({ nodes: new Map() });

    await syncWithCloud(USER, NOW, client);

    expect(cloud.nodes!.get('edited')?.plainText).toBe('rewritten offline');
  });

  it('a rem the cloud never had — restored from a backup — is uploaded, not purged', async () => {
    await addTextNode('restored', 'From an old backup', { updatedAt: NOW - 300 * DAY });
    await addTextNode('other', 'other', { updatedAt: NOW - 300 * DAY });
    const other = (await db.nodes.get('other'))!;
    const { client, cloud } = fakeSupabase({ nodes: new Map([['other', cloudRow(other)]]) });

    await syncWithCloud(USER, NOW, client);

    expect(cloud.nodes!.has('restored')).toBe(true);
    expect(await db.nodes.get('restored')).toBeDefined();
  });

  it('the cloud drops tombstones past the window, and so does this device; younger ones stay', async () => {
    const old = await addTextNode('old', 'old', { deletedAt: NOW - 100 * DAY, updatedAt: NOW - 100 * DAY });
    const young = await addTextNode('young', 'young', { deletedAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY });
    const { client, cloud } = fakeSupabase({
      nodes: new Map([
        ['old', cloudRow(old)],
        ['young', cloudRow(young)],
      ]),
    });
    await db.syncBase.bulkPut([{ id: 'old', row: forRemote(old) }, { id: 'young', row: forRemote(young) }]);

    await syncWithCloud(USER, NOW, client);

    expect(cloud.nodes!.has('old')).toBe(false);
    expect(await db.nodes.get('old')).toBeUndefined();
    expect(cloud.nodes!.has('young')).toBe(true);
    expect(await db.nodes.get('young')).toBeDefined();
  });

  it('never uploads childrenIds, even for a row that arrived with it', async () => {
    const legacy = { ...(await addTextNode('p', 'Page', { isPage: true, updatedAt: NOW - DAY })) };
    const { client } = fakeSupabase({
      nodes: new Map([['p', { ...cloudRow(legacy), childrenIds: ['x'], plainText: 'Page renamed', updatedAt: NOW - 1000 }]]),
    });
    await syncWithCloud(USER, NOW, client);
    const local = await db.nodes.get('p');
    expect(local?.plainText).toBe('Page renamed');
    expect(local).not.toHaveProperty('childrenIds');
  });
});
