import { db } from '../db/database';
import { keepVersion } from '../db/versionRepository';
import { LEGACY_NODE_FIELDS, LOCAL_ONLY_NODE_FIELDS, type OutlinerNode } from '../db/schema';
import { findConflicts, threeWayMerge, type MergePlan } from './merge';

/**
 * What sync does about a rem changed on both sides since they last agreed
 * (#22). Split out of the engine so it can be tested without Supabase.
 *
 * With a sync base — the last copy both sides agreed on — the rem is merged
 * field by field: text from the side that edited it, position from the side
 * that moved it, and only a genuine clash (both edited the text) is settled by
 * last-write-wins, with the losing text kept in version history. Without a
 * base (the first sync on a device, or a rem that has never round-tripped)
 * it falls back to last-write-wins plus the kept copy, as before.
 */

/** Content and everything derived from it: always taken from one side together. */
export const CONTENT_GROUP = ['content', 'plainText', 'outboundLinks', 'isCard'];

/**
 * The row as the cloud should see it — without this browser's derived index
 * keys, and without retired fields a row downloaded from an older device may
 * still carry (`childrenIds`, #4).
 */
export function forRemote<T>(row: T): T {
  const copy = { ...(row as Record<string, unknown>) };
  for (const key of LOCAL_ONLY_NODE_FIELDS) delete copy[key];
  for (const key of LEGACY_NODE_FIELDS) delete copy[key];
  return copy as T;
}

function differs(a: OutlinerNode, b: OutlinerNode): boolean {
  return JSON.stringify(forRemote({ ...a, updatedAt: 0 })) !== JSON.stringify(forRemote({ ...b, updatedAt: 0 }));
}

export interface ResolvedPlan {
  plan: MergePlan<OutlinerNode>;
  merged: number;
  kept: number;
}

export async function resolveNodeConflicts(
  plan: MergePlan<OutlinerNode>,
  localSeen: OutlinerNode[],
  remote: OutlinerNode[],
  cursor: { pushedThrough: number; pulledThrough: number }
): Promise<ResolvedPlan> {
  const conflicts = findConflicts(localSeen, remote, cursor, differs);
  if (conflicts.length === 0) return { plan, merged: 0, kept: 0 };

  const bases = await db.syncBase.bulkGet(conflicts.map((c) => c.id));
  const replaced = new Map<string, OutlinerNode>();
  let merged = 0;
  let kept = 0;

  for (let i = 0; i < conflicts.length; i++) {
    const conflict = conflicts[i]!;
    const base = bases[i]?.row;
    const usable = base && base.updatedAt <= Math.min(conflict.local.updatedAt, conflict.remote.updatedAt);

    if (!usable) {
      // No common ancestor: last-write-wins, but the losing text is kept.
      const loser = conflict.winner === 'local' ? conflict.remote : conflict.local;
      if (loser.content !== (conflict.winner === 'local' ? conflict.local : conflict.remote).content && loser.plainText.trim()) {
        if (await keepVersion(loser, 'conflict', { from: conflict.winner === 'local' ? 'another device' : 'this device', seen: false })) kept += 1;
      }
      continue;
    }

    const result = threeWayMerge(base, conflict.local, conflict.remote, [CONTENT_GROUP]);
    const row = forRemote(result.row);
    replaced.set(conflict.id, row);
    merged += 1;

    // Text lost to the merge: a real clash over the text, or text edited on a
    // side whose rem the other side deleted.
    const contentLoser = result.contentFrom === 'local' ? conflict.remote : conflict.local;
    const deletedOverEdit =
      row.deletedAt !== null && !base.deletedAt && [conflict.local, conflict.remote].some((side) => side.content !== base.content);
    if ((result.contentConflict || deletedOverEdit) && contentLoser.plainText.trim()) {
      const loser = deletedOverEdit
        ? [conflict.local, conflict.remote].find((side) => side.content !== base.content)!
        : contentLoser;
      const from = loser === conflict.local ? 'this device' : 'another device';
      if (await keepVersion(loser, 'conflict', { from, seen: false })) kept += 1;
    }
  }

  if (replaced.size === 0) return { plan, merged, kept };
  const rest = (rows: OutlinerNode[]) => rows.filter((row) => !replaced.has(row.id));
  return {
    plan: {
      // The merged row goes both ways: into this browser, and up to the cloud.
      toUpload: [...rest(plan.toUpload), ...replaced.values()],
      toDownload: [...rest(plan.toDownload), ...replaced.values()],
    },
    merged,
    kept,
  };
}

/**
 * Remember what both sides now agree on, as the base for the next merge.
 * `agreed` is every row just uploaded or downloaded, plus rows found identical
 * on both sides.
 */
export async function recordAgreed(agreed: OutlinerNode[]): Promise<void> {
  if (agreed.length === 0) return;
  const unique = new Map(agreed.map((row) => [row.id, forRemote(row)]));
  await db.syncBase.bulkPut([...unique.values()].map((row) => ({ id: row.id, row })));
}
