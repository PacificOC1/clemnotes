import { supabase } from './supabaseClient';
import { db } from '../db/database';
import type { OutlinerNode } from '../db/schema';

export interface SyncResult {
  pushed: number;
  pulled: number;
}

/**
 * Two-way sync between the local IndexedDB store and the `nodes` table in
 * Supabase, scoped to `userId`. Conflict resolution is simple last-write-wins
 * by `updatedAt` — fine for a single-user app syncing across their own
 * devices, where true concurrent edits to the same bullet are rare. Deletes
 * are just another field mutation (`deletedAt`) so they sync the same way
 * as any other change, no special-casing needed.
 */
export async function syncWithCloud(userId: string): Promise<SyncResult> {
  if (!supabase) throw new Error('Cloud sync is not configured');

  const local = await db.nodes.toArray();
  const { data: remoteRows, error } = await supabase.from('nodes').select('*').eq('userId', userId);
  if (error) throw error;

  const remote = (remoteRows ?? []) as (OutlinerNode & { userId: string })[];

  const localById = new Map(local.map((n) => [n.id, n]));
  const remoteById = new Map(remote.map((n) => [n.id, n]));

  const toUpload: OutlinerNode[] = [];
  const toDownload: OutlinerNode[] = [];

  const allIds = new Set([...localById.keys(), ...remoteById.keys()]);
  for (const id of allIds) {
    const l = localById.get(id);
    const r = remoteById.get(id);
    if (l && !r) {
      toUpload.push(l);
    } else if (r && !l) {
      toDownload.push(r);
    } else if (l && r) {
      if (l.updatedAt > r.updatedAt) toUpload.push(l);
      else if (r.updatedAt > l.updatedAt) toDownload.push(r);
      // equal updatedAt: already in sync, nothing to do
    }
  }

  if (toUpload.length > 0) {
    const rows = toUpload.map((n) => ({ ...n, userId }));
    const { error: upErr } = await supabase.from('nodes').upsert(rows);
    if (upErr) throw upErr;
  }

  if (toDownload.length > 0) {
    const clean = toDownload.map((n) => {
      const { userId: _drop, ...rest } = n as OutlinerNode & { userId?: string };
      return rest as OutlinerNode;
    });
    await db.nodes.bulkPut(clean);
  }

  return { pushed: toUpload.length, pulled: toDownload.length };
}
