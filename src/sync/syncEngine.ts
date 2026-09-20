import type { Table } from 'dexie';
import { supabase } from './supabaseClient';
import { db } from '../db/database';
import {
  advanceWatermark,
  missingLocally,
  planAppendOnlyMerge,
  planIncrementalMerge,
  planMerge,
  type MergePlan,
  type Syncable,
} from './merge';
import { readCursor, writeCursor, type SyncCursor } from './cursors';
import { invalidateSearchIndex } from '../db/searchIndex';

export interface TableSyncResult {
  table: string;
  pushed: number;
  pulled: number;
  /** True when this run re-read the whole table rather than only what changed. */
  reconciled: boolean;
  error?: string;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  tables: TableSyncResult[];
  /** Tables that failed — almost always because the Supabase migration hasn't been run yet. */
  failed: string[];
}

/**
 * How long between full reconciles.
 *
 * Incremental pulls trust `updatedAt`, which is stamped by whichever device
 * wrote the row. That is reliable enough for minute-to-minute work and not
 * reliable enough to be the only thing standing between you and a lost note,
 * so once a day every table is re-read in full and reconciled properly.
 */
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How far short of the newest row seen the pull watermark is parked. */
const CLOCK_SLACK_MS = 60_000;

/** `in` on more than a few hundred ids makes a URL PostgREST rejects outright. */
const ID_BATCH = 200;

function stripUserId<T>(rows: unknown[]): T[] {
  return rows.map((row) => {
    const { userId: _drop, ...rest } = row as { userId?: string };
    return rest as T;
  });
}

/** Whether this run should re-read everything rather than only what changed. */
function needsReconcile(cursor: SyncCursor, now: number): boolean {
  return cursor.reconciledAt === 0 || now - cursor.reconciledAt > RECONCILE_INTERVAL_MS;
}

/**
 * Merge one table between local IndexedDB and Supabase, scoped to `userId`.
 *
 * Conflict resolution is last-write-wins on `updatedAt` — fine for one person
 * syncing their own devices, where true concurrent edits to the same row are
 * rare and a delete is just another field change (`deletedAt`) travelling
 * through the same comparison.
 *
 * What changes with the cursor is only *what gets fetched*. A normal run pulls
 * the rows changed since the last pull and pushes the rows written since the
 * last push, which at rest is two empty result sets rather than a copy of the
 * entire database every twenty seconds. Once a day — and on the first sync on
 * a device, and any time the cursor is missing — it falls back to reading
 * everything, which is what makes a lost cursor, a cleared browser or a
 * skewed clock self-correcting rather than silently lossy.
 */
async function syncTable<T extends Syncable>(
  localTable: Table<T, string>,
  remoteTable: string,
  userId: string,
  now = Date.now()
): Promise<TableSyncResult> {
  if (!supabase) throw new Error('Cloud sync is not configured');

  const cursor = readCursor(userId, remoteTable);
  const reconciled = needsReconcile(cursor, now);

  // Captured before anything is read, so a write that lands mid-sync is caught
  // by the next run rather than falling between the two.
  const startedAt = now;

  let query = supabase.from(remoteTable).select('*').eq('userId', userId);
  if (!reconciled) query = query.gt('updatedAt', cursor.pulledThrough);
  const { data: remoteRows, error } = await query;
  if (error) throw error;
  const remote = stripUserId<T>(remoteRows ?? []);

  let plan: MergePlan<T>;
  if (reconciled) {
    plan = planMerge(await localTable.toArray(), remote);
  } else {
    const changedLocal = await localTable
      .where('updatedAt')
      .aboveOrEqual(cursor.pushedThrough)
      .toArray();
    const localForRemote = (await localTable.bulkGet(remote.map((row) => row.id))).filter(
      (row): row is T => row !== undefined
    );
    plan = planIncrementalMerge({ changedLocal, remote, localForRemote });
  }

  if (plan.toUpload.length > 0) {
    const { error: upErr } = await supabase
      .from(remoteTable)
      .upsert(plan.toUpload.map((row) => ({ ...row, userId })));
    if (upErr) throw upErr;
  }

  if (plan.toDownload.length > 0) {
    await localTable.bulkPut(plan.toDownload);
    // Rows arrived from another device; the search index no longer matches.
    if (remoteTable === 'nodes') invalidateSearchIndex();
  }

  // Only advanced once both halves have succeeded: a cursor moved past rows
  // that were never actually written is the one failure this design must not
  // have, and the cost of not moving it is a repeated fetch.
  writeCursor(userId, remoteTable, {
    pulledThrough: advanceWatermark(remote, cursor.pulledThrough, CLOCK_SLACK_MS),
    pushedThrough: startedAt,
    reconciledAt: reconciled ? startedAt : cursor.reconciledAt,
  });

  return {
    table: remoteTable,
    pushed: plan.toUpload.length,
    pulled: plan.toDownload.length,
    reconciled,
  };
}

/**
 * Merge an append-only table — one whose rows are written once and never
 * touched again.
 *
 * Because the rows are immutable there is nothing to compare: a row either
 * exists on the other side or it does not. So the pull asks only for ids, and
 * full rows are fetched only for the ones actually missing. With a cursor it
 * asks only for ids newer than the last pull, which for the review log — the
 * one table with no ceiling on its size, and which grows even on days you
 * write nothing — is the difference between a poll that costs nothing and one
 * that grows forever.
 */
async function syncAppendOnlyTable<T extends Syncable>(
  localTable: Table<T, string>,
  remoteTable: string,
  userId: string,
  now = Date.now()
): Promise<TableSyncResult> {
  if (!supabase) throw new Error('Cloud sync is not configured');

  const cursor = readCursor(userId, remoteTable);
  const reconciled = needsReconcile(cursor, now);
  const startedAt = now;

  let idQuery = supabase.from(remoteTable).select('id,updatedAt').eq('userId', userId);
  if (!reconciled) idQuery = idQuery.gt('updatedAt', cursor.pulledThrough);
  const { data: remoteIdRows, error } = await idQuery;
  if (error) throw error;

  const remoteStubs = (remoteIdRows ?? []) as Array<{ id: string; updatedAt: number }>;
  const remoteIds = remoteStubs.map((row) => row.id);

  let toUpload: T[];
  let missingIds: string[];

  if (reconciled) {
    const local = await localTable.toArray();
    ({ toUpload, missingIds } = planAppendOnlyMerge(local, remoteIds));
  } else {
    // Re-uploading a row the remote already has is an upsert onto itself, so
    // the push side needs no knowledge of the remote at all.
    toUpload = await localTable.where('updatedAt').aboveOrEqual(cursor.pushedThrough).toArray();
    missingIds = missingLocally(remoteIds, await localTable.bulkGet(remoteIds));
  }

  if (toUpload.length > 0) {
    const { error: upErr } = await supabase
      .from(remoteTable)
      .upsert(toUpload.map((row) => ({ ...row, userId })));
    if (upErr) throw upErr;
  }

  let pulled = 0;
  for (let i = 0; i < missingIds.length; i += ID_BATCH) {
    const batch = missingIds.slice(i, i + ID_BATCH);
    const { data: rows, error: downErr } = await supabase
      .from(remoteTable)
      .select('*')
      .eq('userId', userId)
      .in('id', batch);
    if (downErr) throw downErr;
    const clean = stripUserId<T>(rows ?? []);
    if (clean.length > 0) await localTable.bulkPut(clean);
    pulled += clean.length;
  }

  writeCursor(userId, remoteTable, {
    pulledThrough: advanceWatermark(remoteStubs, cursor.pulledThrough, CLOCK_SLACK_MS),
    pushedThrough: startedAt,
    reconciledAt: reconciled ? startedAt : cursor.reconciledAt,
  });

  return { table: remoteTable, pushed: toUpload.length, pulled, reconciled };
}

/**
 * Sync every table that has a cloud counterpart. Each table is merged
 * independently and a failure in one doesn't abandon the others — so if the
 * Supabase migration adding `dictionary`, `folders` and `cards` hasn't been
 * run yet, your notes still sync and the UI can tell you exactly which tables
 * are missing rather than the whole sync just breaking.
 *
 * Each table also carries its own cursor, so a table that failed today simply
 * has more to catch up on tomorrow — one broken table can never advance
 * another table's position.
 */
export async function syncWithCloud(userId: string, now = Date.now()): Promise<SyncResult> {
  if (!supabase) throw new Error('Cloud sync is not configured');

  const jobs: Array<[string, () => Promise<TableSyncResult>]> = [
    ['nodes', () => syncTable(db.nodes, 'nodes', userId, now)],
    ['dictionary', () => syncTable(db.dictionary, 'dictionary', userId, now)],
    ['folders', () => syncTable(db.folders, 'folders', userId, now)],
    ['cards', () => syncTable(db.cards, 'cards', userId, now)],
    ['reviews', () => syncAppendOnlyTable(db.reviews, 'reviews', userId, now)],
  ];

  const tables: TableSyncResult[] = [];
  const failed: string[] = [];

  for (const [name, run] of jobs) {
    try {
      tables.push(await run());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tables.push({ table: name, pushed: 0, pulled: 0, reconciled: false, error: message });
      failed.push(name);
    }
  }

  // Every table failing means something systemic (offline, bad credentials),
  // not a missing migration — surface that as a real error.
  if (failed.length === jobs.length) {
    const first = tables.find((t) => t.error)?.error ?? 'Sync failed';
    throw new Error(first);
  }

  return {
    pushed: tables.reduce((sum, t) => sum + t.pushed, 0),
    pulled: tables.reduce((sum, t) => sum + t.pulled, 0),
    tables,
    failed,
  };
}
