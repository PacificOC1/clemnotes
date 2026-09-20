/**
 * The conflict-resolution rules cloud sync runs on, as pure functions.
 *
 * These live apart from `syncEngine.ts` on purpose. The engine's job is
 * talking to Supabase — fetching, upserting, batching, surviving a table that
 * isn't migrated yet — and none of that can run in a test. What actually
 * decides whether your notes survive syncing is the handful of comparisons
 * below, and separating them means they can be tested exhaustively against a
 * known set of conflicts instead of against a live database.
 *
 * It is also the shape roadmap item 14 needs: incremental sync changes *what*
 * gets fetched, not how two versions of a row are reconciled, so the rules
 * here should come through that change untouched.
 */

/** Everything a row needs to take part in the merge. */
export interface Syncable {
  id: string;
  updatedAt: number;
  deletedAt: number | null;
}

export interface MergePlan<T> {
  toUpload: T[];
  toDownload: T[];
}

/**
 * Last-write-wins by `updatedAt`.
 *
 * A row present on one side only travels to the other, whatever its age — that
 * is what makes a fresh device fill itself from the cloud, and a cloud table
 * fill itself from a device that has been offline since before it existed.
 *
 * A row present on both sides is decided by `updatedAt` alone. Deletion is not
 * a special case: a tombstone is just a row whose `deletedAt` was set at some
 * moment, so it wins or loses on exactly the same comparison as any other
 * edit. That is the whole reason deletes are soft — a row that simply vanished
 * locally would be indistinguishable from one this device had never seen, and
 * the next pull would bring it straight back.
 *
 * Equal timestamps mean neither side moves. Two genuinely different rows
 * written in the same millisecond would be missed, which is the known cost of
 * whole-row LWW (roadmap item 22) and not something a tie-break can fix.
 */
export function planMerge<T extends Syncable>(local: T[], remote: T[]): MergePlan<T> {
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

  return { toUpload, toDownload };
}

export interface AppendOnlyPlan<T> {
  toUpload: T[];
  /** Remote ids with no local row — the only ones worth fetching in full. */
  missingIds: string[];
}

/**
 * The same job for a table whose rows are written once and never touched.
 *
 * Because nothing ever updates such a row, there is nothing to compare: a row
 * either exists on the other side or it does not. So the poll only needs the
 * remote's ids, and full rows are fetched only for the ones actually missing —
 * which is what keeps the review log, the one table with no ceiling on its
 * size, from dominating every sync.
 */
export function planAppendOnlyMerge<T extends Syncable>(
  local: T[],
  remoteIds: Iterable<string>
): AppendOnlyPlan<T> {
  const remote = new Set(remoteIds);
  const localIds = new Set(local.map((row) => row.id));

  return {
    toUpload: local.filter((row) => !remote.has(row.id)),
    missingIds: [...remote].filter((id) => !localIds.has(id)),
  };
}

/**
 * The same last-write-wins decision, made from a *partial* view of the remote.
 *
 * An incremental pull only fetches rows changed since the last sync, so the
 * local side has to be assembled to match: every local row that has changed
 * since the last push (those are the candidates to upload), plus the local
 * counterparts of whatever the pull returned (those are the candidates for a
 * genuine conflict). Anything outside both sets is a row neither side has
 * touched, and there is by definition nothing to decide about it.
 *
 * The decision itself is then `planMerge`, unchanged — which is the point.
 * Incremental sync changes what gets fetched, not what winning means.
 */
export function planIncrementalMerge<T extends Syncable>(input: {
  /** Local rows written since the last successful push. */
  changedLocal: T[];
  /** Remote rows changed since the last successful pull. */
  remote: T[];
  /** Local rows matching the ids the pull returned, where they exist locally. */
  localForRemote: T[];
}): MergePlan<T> {
  const localById = new Map<string, T>();
  // `changedLocal` second: where a row is in both sets it is the same row, but
  // the local read for it is the fresher of the two.
  for (const row of input.localForRemote) localById.set(row.id, row);
  for (const row of input.changedLocal) localById.set(row.id, row);
  return planMerge([...localById.values()], input.remote);
}

/**
 * Where to set the pull watermark after a batch of remote rows.
 *
 * Deliberately short of the newest row seen. `updatedAt` is stamped by whichever
 * device wrote the row, so two devices with clocks a few seconds apart can write
 * rows whose timestamps interleave — and a watermark parked exactly on the
 * newest one would step over anything the other device wrote a moment "earlier".
 * Holding back by a slack window means each sync re-examines a small overlap,
 * which costs almost nothing and closes that gap. The daily full reconcile
 * catches skew larger than the slack.
 *
 * Never moves backwards, so an empty batch leaves the watermark where it was.
 */
export function advanceWatermark(
  rows: Array<{ updatedAt: number }>,
  previous: number,
  slackMs: number
): number {
  let newest = previous;
  for (const row of rows) if (row.updatedAt > newest) newest = row.updatedAt;
  return Math.max(previous, newest - slackMs);
}

/**
 * Which of the remote's ids this device does not have.
 *
 * `localRows` is the result of looking each id up locally, in the same order —
 * Dexie's `bulkGet` shape, where a miss is `undefined`.
 */
export function missingLocally(
  remoteIds: string[],
  localRows: Array<{ id: string } | undefined>
): string[] {
  return remoteIds.filter((_, i) => localRows[i] === undefined);
}
