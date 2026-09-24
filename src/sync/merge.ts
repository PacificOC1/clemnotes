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

/** A row both sides changed since they last agreed. */
export interface Conflict<T> {
  id: string;
  local: T;
  remote: T;
  /** Which side last-write-wins is about to keep. */
  winner: 'local' | 'remote';
}

/**
 * Rows edited on this device *and* elsewhere since the last sync — the case
 * last-write-wins resolves by silently discarding one side.
 *
 * "Changed here" is a local row written at or after the push cursor (so not
 * yet sent); "changed there" is a remote row newer than the pull cursor. Both
 * true and `differs` says the difference matters: that is a conflict. Merging
 * still picks a winner exactly as before — this only says who lost, so the
 * caller can keep the losing side somewhere instead of dropping it.
 *
 * A first sync (both cursors at 0) calls every differing row a conflict,
 * which is right: two copies that have never been compared can't be told
 * apart from two copies edited separately.
 */
export function findConflicts<T extends Syncable>(
  local: T[],
  remote: T[],
  cursor: { pushedThrough: number; pulledThrough: number },
  differs: (a: T, b: T) => boolean
): Conflict<T>[] {
  const localById = new Map(local.map((row) => [row.id, row]));
  const out: Conflict<T>[] = [];
  for (const theirs of remote) {
    const mine = localById.get(theirs.id);
    if (!mine || mine.updatedAt === theirs.updatedAt) continue;
    const changedHere = mine.updatedAt >= cursor.pushedThrough;
    const changedThere = theirs.updatedAt > cursor.pulledThrough;
    if (!changedHere || !changedThere || !differs(mine, theirs)) continue;
    out.push({ id: theirs.id, local: mine, remote: theirs, winner: mine.updatedAt > theirs.updatedAt ? 'local' : 'remote' });
  }
  return out;
}

/** Fields a three-way merge must not treat as data. */
const MERGE_IGNORED = new Set(['id', 'updatedAt', 'createdAt', 'userId', 'rootKey', 'cardKey', 'titleKey', 'childrenIds']);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface ThreeWayResult<T> {
  row: T;
  /** Both sides changed the content group differently — the loser's text needs keeping. */
  contentConflict: boolean;
  /** Which side's content the result carries. */
  contentFrom: 'local' | 'remote';
}

/**
 * Merge a row both sides changed, field by field, against the copy they last
 * agreed on (#22).
 *
 * Whole-row last-write-wins answers "which device touched it last?", and so
 * loses an edit whenever the *other* device touched the same rem for a
 * different reason: text edited on the laptop, the rem dragged somewhere else
 * on the phone, and whichever synced second erased the other change. With the
 * base, each field can be asked separately: changed on one side only → that
 * side's value; changed on both → the newer side's, as before.
 *
 * `groups` bundles fields that only make sense together — a rem's content and
 * everything derived from it (plain text, links, whether it makes cards) must
 * come from the same side, or the derived fields would describe text the row
 * doesn't hold.
 *
 * The result is stamped newer than both sides, so it wins everywhere next.
 */
export function threeWayMerge<T extends Syncable>(
  base: T,
  local: T,
  remote: T,
  groups: string[][] = []
): ThreeWayResult<T> {
  const localNewer = local.updatedAt >= remote.updatedAt;
  const grouped = new Set(groups.flat());
  const units: string[][] = [...groups];
  const keys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);
  for (const key of keys) {
    if (!MERGE_IGNORED.has(key) && !grouped.has(key)) units.push([key]);
  }

  const out: Record<string, unknown> = { ...((localNewer ? local : remote) as unknown as Record<string, unknown>) };
  const b = base as unknown as Record<string, unknown>;
  const l = local as unknown as Record<string, unknown>;
  const r = remote as unknown as Record<string, unknown>;
  let contentConflict = false;
  let contentFrom: 'local' | 'remote' = localNewer ? 'local' : 'remote';

  units.forEach((unit, index) => {
    const localChanged = unit.some((k) => !same(l[k], b[k]));
    const remoteChanged = unit.some((k) => !same(r[k], b[k]));
    let from: 'local' | 'remote';
    if (localChanged && !remoteChanged) from = 'local';
    else if (remoteChanged && !localChanged) from = 'remote';
    else from = localNewer ? 'local' : 'remote';
    const source = from === 'local' ? l : r;
    for (const k of unit) {
      if (source[k] === undefined) delete out[k];
      else out[k] = source[k];
    }
    // The first group is the content group, by convention of the caller.
    if (index === 0 && groups.length > 0) {
      contentFrom = from;
      contentConflict = localChanged && remoteChanged && unit.some((k) => !same(l[k], r[k]));
    }
  });

  out.updatedAt = Math.max(local.updatedAt, remote.updatedAt) + 1;
  return { row: out as unknown as T, contentConflict, contentFrom };
}


/** How long a deleted row is kept before it is purged for good (#24). */
export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Which local rows the cloud no longer has because they were purged — rows to
 * delete here, not to upload.
 *
 * A full reconcile uploads every local row the cloud lacks, which is right for
 * a row that was never sent and wrong for one the cloud deliberately dropped:
 * uploading it would bring a purged rem back from the dead. Two cases are
 * safe to call "purged":
 *
 * - it is itself a tombstone older than the retention window — the cloud
 *   drops those, and so should this device;
 * - both sides agreed on this exact row before (`agreedUnchanged`: it has a
 *   sync base and hasn't changed since), so the cloud had it, and the only
 *   thing that removes a row from the cloud is the purge. That catches a
 *   device that was offline long enough to miss the delete *and* the purge.
 *
 * A live row the cloud never agreed on (restored from a backup, written
 * offline, from before sync bases existed) is uploaded as before. A limit
 * guards the second rule against the one case it can't see — a cloud table
 * wiped by hand: if an implausible share of the notebook looks purged, those
 * rows are uploaded instead (`refused`).
 */
export function planPurges<T extends Syncable>(input: {
  /** Local rows the remote does not have. */
  missingRemotely: T[];
  /** Ids agreed with the cloud before and unchanged here since. */
  agreedUnchanged: ReadonlySet<string>;
  now: number;
  retentionMs?: number;
  /** How many local rows there are — for the sanity limit. */
  localCount: number;
  /** How many rows the remote returned — an empty remote is never "purged". */
  remoteCount: number;
}): { purge: T[]; refused: boolean } {
  const horizon = input.now - (input.retentionMs ?? TOMBSTONE_RETENTION_MS);
  const expired = (row: T) => row.deletedAt !== null && row.deletedAt < horizon;
  // Old tombstones are always safe to drop: they are deletions either way.
  const tombstones = input.missingRemotely.filter(expired);
  // Rows presumed purged because the cloud once had them get the sanity check.
  const agreed = input.missingRemotely.filter((row) => !expired(row) && input.agreedUnchanged.has(row.id));
  const limit = Math.max(50, Math.floor(input.localCount * 0.2));
  const refused = agreed.length > 0 && (input.remoteCount === 0 || agreed.length > limit);
  return { purge: refused ? tombstones : [...tombstones, ...agreed], refused };
}
