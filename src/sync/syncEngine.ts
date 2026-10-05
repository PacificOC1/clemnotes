import type { Table } from 'dexie';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';
import { db } from '../db/database';
import {
  advanceWatermark,
  missingLocally,
  planAppendOnlyMerge,
  planIncrementalMerge,
  planMerge,
  planPurges,
  TOMBSTONE_RETENTION_MS,
  type MergePlan,
  type Syncable,
} from './merge';
import { readCursor, writeCursor, type SyncCursor } from './cursors';
import { invalidateSearchIndex } from '../db/searchIndex';
import { uploadPendingImages, type ImageSyncResult } from './imageSync';
import type { OutlinerNode } from '../db/schema';
import { forRemote, recordAgreed, resolveNodeConflicts } from './nodeMerge';
import { logEvent } from '../diagnostics';
import { deleteRowsForGood, type PurgeableTable } from '../db/tombstones';

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
  /** How image and PDF uploads went, and to which store. */
  files?: ImageSyncResult;
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

/**
 * Rows asked for per select. Supabase's PostgREST returns at most `max-rows`
 * (1000 by default) from any one request, however many match — so a table
 * bigger than that has to be read in pages, or a fresh browser gets back only
 * part of your notes. Pages run in `id` order and continue after the last id
 * seen, and reading stops only at an empty page, so a project whose
 * `max-rows` is set lower than this still gets everything.
 */
const SELECT_PAGE = 1000;

/** Rows per upsert: one course is thousands of rems, too big for one request body. */
const UPSERT_BATCH = 500;

type PageResult = PromiseLike<{ data: unknown[] | null; error: unknown }>;

/**
 * Every row a query matches, read a page at a time. `page(afterId)` builds
 * the query for the rows after `afterId` (null for the first page); it must
 * order by `id` and filter `id > afterId` when given one.
 */
async function selectAllPages<R>(page: (afterId: string | null) => PageResult): Promise<R[]> {
  const out: R[] = [];
  let afterId: string | null = null;
  for (;;) {
    const { data, error } = await page(afterId);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: string }>;
    if (rows.length === 0) return out;
    out.push(...(rows as unknown as R[]));
    const lastId = rows[rows.length - 1]!.id;
    // A page that doesn't move forward would loop for ever; stop instead.
    if (lastId === afterId) return out;
    afterId = lastId;
  }
}

/** Upsert in requests of `UPSERT_BATCH` rows. */
async function upsertInBatches(supabase: SupabaseClient, remoteTable: string, rows: object[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const { error } = await supabase.from(remoteTable).upsert(rows.slice(i, i + UPSERT_BATCH));
    if (error) throw error;
  }
}

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
  supabase: SupabaseClient,
  localTable: Table<T, string>,
  remoteTable: string,
  userId: string,
  now = Date.now()
): Promise<TableSyncResult> {
  const cursor = readCursor(userId, remoteTable);
  const reconciled = needsReconcile(cursor, now);

  // Captured before anything is read, so a write that lands mid-sync is caught
  // by the next run rather than falling between the two.
  const startedAt = now;

  // #24: once a day, before reading, the cloud forgets tombstones older than
  // the retention window. Every device then follows at its own reconcile
  // (below), so they all agree on when a row stopped existing. A failure here
  // costs nothing but a longer-lived tombstone.
  let purgedRemotely = 0;
  if (reconciled) {
    const { error: purgeErr, count } = await supabase
      .from(remoteTable)
      .delete({ count: 'exact' })
      .eq('userId', userId)
      .lt('deletedAt', now - TOMBSTONE_RETENTION_MS);
    if (purgeErr) logEvent('sync', `Couldn't purge old deletions from ${remoteTable}: ${purgeErr.message}`, undefined, 'warn');
    else purgedRemotely = count ?? 0;
  }

  const remoteRows = await selectAllPages<unknown>((afterId) => {
    let query = supabase.from(remoteTable).select('*').eq('userId', userId);
    if (!reconciled) query = query.gt('updatedAt', cursor.pulledThrough);
    if (afterId !== null) query = query.gt('id', afterId);
    return query.order('id').limit(SELECT_PAGE);
  });
  const remote = stripUserId<T>(remoteRows);

  let plan: MergePlan<T>;
  let localSeen: T[];
  if (reconciled) {
    localSeen = await localTable.toArray();
    plan = planMerge(localSeen, remote);

    // Rows the cloud purged are deleted here rather than uploaded back.
    const remoteIds = new Set(remote.map((row) => row.id));
    const missingRemotely = plan.toUpload.filter((row) => !remoteIds.has(row.id));
    const agreedUnchanged = new Set<string>();
    if (remoteTable === 'nodes' && missingRemotely.length > 0) {
      const bases = await db.syncBase.bulkGet(missingRemotely.map((row) => row.id));
      missingRemotely.forEach((row, i) => {
        const base = bases[i]?.row;
        if (base && row.updatedAt <= base.updatedAt) agreedUnchanged.add(row.id);
      });
    }
    const { purge, refused } = planPurges({
      missingRemotely,
      agreedUnchanged,
      now,
      localCount: localSeen.length,
      remoteCount: remote.length,
    });
    if (refused) {
      logEvent('sync', `Too much of ${remoteTable} is missing from the cloud to be purges; uploading it instead`, { missing: missingRemotely.length }, 'warn');
    }
    if (purge.length > 0 || purgedRemotely > 0) {
      const purgeIds = new Set(purge.map((row) => row.id));
      await deleteRowsForGood(remoteTable as PurgeableTable, [...purgeIds]);
      plan = { ...plan, toUpload: plan.toUpload.filter((row) => !purgeIds.has(row.id)) };
      localSeen = localSeen.filter((row) => !purgeIds.has(row.id));
      logEvent('sync', `Purged old deletions from ${remoteTable}`, { cloud: purgedRemotely, here: purge.length });
    }
  } else {
    const changedLocal = await localTable
      .where('updatedAt')
      .aboveOrEqual(cursor.pushedThrough)
      .toArray();
    const localForRemote = (await localTable.bulkGet(remote.map((row) => row.id))).filter(
      (row): row is T => row !== undefined
    );
    localSeen = [...localForRemote, ...changedLocal];
    plan = planIncrementalMerge({ changedLocal, remote, localForRemote });
  }

  // #22: rems changed here *and* elsewhere since the last sync are merged
  // field by field against the copy both last agreed on (see nodeMerge.ts).
  if (remoteTable === 'nodes') {
    const resolved = await resolveNodeConflicts(
      plan as unknown as MergePlan<OutlinerNode>,
      localSeen as unknown as OutlinerNode[],
      remote as unknown as OutlinerNode[],
      cursor
    );
    plan = resolved.plan as unknown as MergePlan<T>;
    if (resolved.merged || resolved.kept) {
      logEvent('sync', 'Rems edited on two devices', { merged: resolved.merged, textKept: resolved.kept }, resolved.kept ? 'warn' : 'info');
    }
  }

  if (plan.toUpload.length > 0) {
    await upsertInBatches(supabase, remoteTable, plan.toUpload.map((row) => ({ ...forRemote(row), userId })));
  }

  if (plan.toDownload.length > 0) {
    await localTable.bulkPut(plan.toDownload);
    // Rows arrived from another device; the search index no longer matches.
    if (remoteTable === 'nodes') invalidateSearchIndex();
  }

  // Both halves succeeded: everything that moved, and everything found
  // identical on both sides, is now the agreed base for the next merge.
  if (remoteTable === 'nodes') {
    const localById = new Map((localSeen as unknown as OutlinerNode[]).map((row) => [row.id, row]));
    const identical = (remote as unknown as OutlinerNode[]).filter((row) => localById.get(row.id)?.updatedAt === row.updatedAt);
    await recordAgreed([
      ...(plan.toUpload as unknown as OutlinerNode[]),
      ...(plan.toDownload as unknown as OutlinerNode[]),
      ...identical,
    ]);
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
  supabase: SupabaseClient,
  localTable: Table<T, string>,
  remoteTable: string,
  userId: string,
  now = Date.now()
): Promise<TableSyncResult> {
  const cursor = readCursor(userId, remoteTable);
  const reconciled = needsReconcile(cursor, now);
  const startedAt = now;

  const remoteStubs = await selectAllPages<{ id: string; updatedAt: number }>((afterId) => {
    let idQuery = supabase.from(remoteTable).select('id,updatedAt').eq('userId', userId);
    if (!reconciled) idQuery = idQuery.gt('updatedAt', cursor.pulledThrough);
    if (afterId !== null) idQuery = idQuery.gt('id', afterId);
    return idQuery.order('id').limit(SELECT_PAGE);
  });
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
    await upsertInBatches(supabase, remoteTable, toUpload.map((row) => ({ ...row, userId })));
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
export async function syncWithCloud(userId: string, now = Date.now(), client?: SupabaseClient): Promise<SyncResult> {
  // `client` is for tests, which hand in an in-memory stand-in for Supabase.
  const supabase = client ?? (await getSupabase());
  if (!supabase) throw new Error('Cloud sync is not configured');

  const jobs: Array<[string, () => Promise<TableSyncResult>]> = [
    ['nodes', () => syncTable(supabase, db.nodes, 'nodes', userId, now)],
    ['dictionary', () => syncTable(supabase, db.dictionary, 'dictionary', userId, now)],
    ['folders', () => syncTable(supabase, db.folders, 'folders', userId, now)],
    ['cards', () => syncTable(supabase, db.cards, 'cards', userId, now)],
    ['reviews', () => syncAppendOnlyTable(supabase, db.reviews, 'reviews', userId, now)],
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
    logEvent('sync', `Sync failed: ${first}`, undefined, 'error');
    throw new Error(first);
  }

  // Image bytes go to a file store rather than a table, after the rows: a rem
  // that shows an image is more useful arriving before its picture than after.
  // With Supabase Storage, a failure is reported like a table's, so a missing
  // bucket reads like a missing migration. With OneDrive, it is a sign-in or
  // a connection problem, which the sidebar shows on its own.
  const files: ImageSyncResult = await uploadPendingImages(userId, supabase).catch((err: unknown) => ({
    store: 'supabase' as const,
    uploaded: 0,
    pending: 0,
    error: err instanceof Error ? err.message : String(err),
  }));
  const bucketFailed = files.store === 'supabase' && Boolean(files.error);
  tables.push({ table: 'images', pushed: files.uploaded, pulled: 0, reconciled: false, error: bucketFailed ? files.error : undefined });
  if (bucketFailed) failed.push('images');

  const pushed = tables.reduce((sum, t) => sum + t.pushed, 0);
  const pulled = tables.reduce((sum, t) => sum + t.pulled, 0);
  if (pushed || pulled || failed.length || tables.some((t) => t.reconciled)) {
    logEvent(
      'sync',
      failed.length ? `Synced with ${failed.length} table(s) failing` : 'Synced',
      {
        pushed,
        pulled,
        reconciled: tables.filter((t) => t.reconciled).map((t) => t.table).join(',') || null,
        failed: tables.filter((t) => t.error).map((t) => `${t.table}: ${t.error}`).join('; ') || null,
      },
      failed.length ? 'warn' : 'info'
    );
  }

  return {
    pushed: tables.reduce((sum, t) => sum + t.pushed, 0),
    pulled: tables.reduce((sum, t) => sum + t.pulled, 0),
    tables,
    failed,
    files,
  };
}
