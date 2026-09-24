import Dexie from 'dexie';
import { db } from './database';
import { removeFromIndex } from './searchIndex';
import { TOMBSTONE_RETENTION_MS } from '../sync/merge';

/**
 * Removing deleted rows for good (#24).
 *
 * Deletes are soft — a `deletedAt` stamp — so that a delete can travel through
 * sync like any other edit instead of being undone by the next device that
 * still has the row. The cost is that tombstones used to be kept forever:
 * every rem ever deleted stayed in both databases, in every backup and every
 * full reconcile, and any image it once showed could never be cleaned up.
 *
 * After `TOMBSTONE_RETENTION_MS` (90 days) a tombstone has done its job. With
 * sync on, the cloud purges it during the daily reconcile and each device
 * follows (see `planPurges`); without sync, this device purges its own.
 */

/** The synced tables that soft-delete. The review log is append-only and never deletes. */
export const PURGEABLE_TABLES = ['nodes', 'cards', 'dictionary', 'folders'] as const;
export type PurgeableTable = (typeof PURGEABLE_TABLES)[number];

/**
 * Hard-delete rows from one table, with what hangs off them: for rems, their
 * cards, their version history, their sync base and their search-index entry.
 */
export async function deleteRowsForGood(table: PurgeableTable, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (table !== 'nodes') {
    await db.table(table).bulkDelete(ids);
    return;
  }
  await db.transaction('rw', [db.nodes, db.cards, db.versions, db.syncBase], async () => {
    await db.nodes.bulkDelete(ids);
    await db.syncBase.bulkDelete(ids);
    const cardIds = (await db.cards.where('nodeId').anyOf(ids).primaryKeys()) as string[];
    await db.cards.bulkDelete(cardIds);
    for (const id of ids) {
      await db.versions.where('[nodeId+savedAt]').between([id, Dexie.minKey], [id, Dexie.maxKey]).delete();
    }
  });
  removeFromIndex(ids);
}

/** Tombstones in `table` older than the retention window. */
export async function expiredTombstones(table: PurgeableTable, now = Date.now()): Promise<string[]> {
  const horizon = now - TOMBSTONE_RETENTION_MS;
  const rows = (await db.table(table).toArray()) as Array<{ id: string; deletedAt: number | null }>;
  return rows.filter((row) => row.deletedAt !== null && row.deletedAt < horizon).map((row) => row.id);
}

/**
 * Purge this device's own old tombstones — only for a notebook that doesn't
 * sync. With sync on, the cloud decides (so every device agrees on when a row
 * stopped existing) and this device follows at its next reconcile.
 */
export async function purgeLocalTombstones(now = Date.now()): Promise<number> {
  let purged = 0;
  for (const table of PURGEABLE_TABLES) {
    const ids = await expiredTombstones(table, now);
    await deleteRowsForGood(table, ids);
    purged += ids.length;
  }
  return purged;
}
