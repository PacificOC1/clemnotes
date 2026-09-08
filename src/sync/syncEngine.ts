import type { Table } from 'dexie';
import { supabase } from './supabaseClient';
import { db } from '../db/database';

/** Everything a row needs to take part in the merge. */
interface Syncable {
  id: string;
  updatedAt: number;
  deletedAt: number | null;
}

export interface TableSyncResult {
  table: string;
  pushed: number;
  pulled: number;
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
 * Last-write-wins merge of one table between local IndexedDB and Supabase,
 * scoped to `userId`. Conflict resolution is by `updatedAt`, which is fine for
 * a single user syncing their own devices: true concurrent edits to the same
 * row are rare, and deletes are just another field change (`deletedAt`) so
 * they travel through the same comparison as any other edit.
 */
async function syncTable<T extends Syncable>(
  localTable: Table<T, string>,
  remoteTable: string,
  userId: string
): Promise<TableSyncResult> {
  if (!supabase) throw new Error('Cloud sync is not configured');

  const local = await localTable.toArray();
  const { data: remoteRows, error } = await supabase.from(remoteTable).select('*').eq('userId', userId);
  if (error) throw error;

  const remote = (remoteRows ?? []) as (T & { userId: string })[];

  const localById = new Map(local.map((row) => [row.id, row]));
  const remoteById = new Map(remote.map((row) => [row.id, row]));

  const toUpload: T[] = [];
  const toDownload: T[] = [];

  for (const id of new Set([...localById.keys(), ...remoteById.keys()])) {
    const mine = localById.get(id);
    const theirs = remoteById.get(id);
    if (mine && !theirs) toUpload.push(mine);
    else if (theirs && !mine) toDownload.push(theirs);
    else if (mine && theirs) {
      if (mine.updatedAt > theirs.updatedAt) toUpload.push(mine);
      else if (theirs.updatedAt > mine.updatedAt) toDownload.push(theirs);
      // equal updatedAt: already in sync, nothing to do
    }
  }

  if (toUpload.length > 0) {
    const { error: upErr } = await supabase
      .from(remoteTable)
      .upsert(toUpload.map((row) => ({ ...row, userId })));
    if (upErr) throw upErr;
  }

  if (toDownload.length > 0) {
    const clean = toDownload.map((row) => {
      const { userId: _drop, ...rest } = row as T & { userId?: string };
      return rest as T;
    });
    await localTable.bulkPut(clean);
  }

  return { table: remoteTable, pushed: toUpload.length, pulled: toDownload.length };
}

/**
 * Sync every table that has a cloud counterpart. Each table is merged
 * independently and a failure in one doesn't abandon the others — so if the
 * Supabase migration adding `dictionary`, `folders` and `cards` hasn't been
 * run yet, your notes still sync and the UI can tell you exactly which tables
 * are missing rather than the whole sync just breaking.
 */
export async function syncWithCloud(userId: string): Promise<SyncResult> {
  if (!supabase) throw new Error('Cloud sync is not configured');

  const jobs: Array<[string, () => Promise<TableSyncResult>]> = [
    ['nodes', () => syncTable(db.nodes, 'nodes', userId)],
    ['dictionary', () => syncTable(db.dictionary, 'dictionary', userId)],
    ['folders', () => syncTable(db.folders, 'folders', userId)],
    ['cards', () => syncTable(db.cards, 'cards', userId)],
  ];

  const tables: TableSyncResult[] = [];
  const failed: string[] = [];

  for (const [name, run] of jobs) {
    try {
      tables.push(await run());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tables.push({ table: name, pushed: 0, pulled: 0, error: message });
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
