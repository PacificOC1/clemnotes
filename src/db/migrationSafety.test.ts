import { afterEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import {
  SNAPSHOTS_KEPT,
  SNAPSHOT_DB_NAME,
  closeSnapshotDb,
  getSnapshot,
  listSnapshots,
  snapshotBeforeUpgrade,
} from './migrationSafety';
import { backupFromTables } from '../export/backup';
import { parseBackup } from '../export/importBackup';

/**
 * The pre-upgrade snapshot.
 *
 * Each test uses its own database name rather than the app's, so nothing here
 * depends on — or disturbs — the notebook the other suites build.
 */

const V9_STORES = {
  nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
  dictionary: 'id, word, updatedAt',
  folders: 'id, order, updatedAt',
  cards: 'id, nodeId, dueAt, updatedAt',
  reviews: 'id, cardId, nodeId, reviewedAt, updatedAt',
};

let counter = 0;
async function legacyDb(rows: number): Promise<string> {
  counter += 1;
  const name = `safety-test-${counter}`;
  const legacy = new Dexie(name);
  legacy.version(9).stores(V9_STORES);
  await legacy.open();
  await legacy.table('nodes').bulkAdd(
    Array.from({ length: rows }, (_, i) => ({ id: `n${i}`, plainText: `rem ${i}`, updatedAt: i, deletedAt: null }))
  );
  await legacy.table('folders').add({ id: 'f1', name: 'Biology', updatedAt: 1, deletedAt: null });
  legacy.close();
  return name;
}

afterEach(async () => {
  closeSnapshotDb();
  await Dexie.delete(SNAPSHOT_DB_NAME);
});

describe('snapshotBeforeUpgrade', () => {
  it('does nothing for a notebook that does not exist yet', async () => {
    expect(await snapshotBeforeUpgrade(12, 'never-created')).toEqual({ status: 'fresh' });
    expect(await listSnapshots()).toEqual([]);
    // Probing must not have created it either — a first run should look like one.
    expect(await Dexie.exists('never-created')).toBe(false);
  });

  it('does nothing when no upgrade is due', async () => {
    const name = await legacyDb(2);
    expect(await snapshotBeforeUpgrade(9, name)).toEqual({ status: 'current', version: 9 });
    expect(await listSnapshots()).toEqual([]);
  });

  it('copies every table before an upgrade, without changing the original', async () => {
    const name = await legacyDb(3);
    const outcome = await snapshotBeforeUpgrade(12, name, 5000);

    expect(outcome.status).toBe('snapshotted');
    const [summary] = await listSnapshots();
    expect(summary).toMatchObject({ fromVersion: 9, toVersion: 12, takenAt: 5000 });
    expect(summary!.counts).toMatchObject({ nodes: 3, folders: 1, cards: 0 });

    const full = await getSnapshot(summary!.id);
    expect((full!.tables.nodes as Array<{ id: string }>).map((n) => n.id).sort()).toEqual(['n0', 'n1', 'n2']);

    // The probe opened it read-only in effect: still v9, still three rows.
    const check = new Dexie(name);
    await check.open();
    expect(check.verno).toBe(9);
    expect(await check.table('nodes').count()).toBe(3);
    check.close();
  });

  it(`keeps only the newest ${SNAPSHOTS_KEPT}`, async () => {
    for (let i = 0; i < SNAPSHOTS_KEPT + 2; i++) {
      const name = await legacyDb(1);
      await snapshotBeforeUpgrade(12, name, 1000 + i);
    }
    const kept = await listSnapshots();
    expect(kept.map((s) => s.takenAt)).toEqual([1004, 1003, 1002]);
  });

  it('turns a snapshot into a backup the importer accepts', async () => {
    const name = await legacyDb(2);
    await snapshotBeforeUpgrade(12, name, 7000);
    const [summary] = await listSnapshots();
    const full = await getSnapshot(summary!.id);

    const backup = await backupFromTables(full!.tables, full!.fromVersion, full!.takenAt);
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed.schemaVersion).toBe(9);
    expect(parsed.counts.nodes).toBe(2);
    expect(parsed.counts.folders).toBe(1);
  });
});
