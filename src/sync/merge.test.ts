import { describe, expect, it } from 'vitest';
import {
  advanceWatermark,
  missingLocally,
  planAppendOnlyMerge,
  planIncrementalMerge,
  planMerge,
  type Syncable,
} from './merge';

const NOW = 1_700_000_000_000;

function row(id: string, updatedAt: number, deletedAt: number | null = null): Syncable {
  return { id, updatedAt, deletedAt };
}

/** Ids only — the merge's decisions are about which rows move, not their contents. */
function ids(rows: Syncable[]): string[] {
  return rows.map((r) => r.id).sort();
}

describe('planMerge', () => {
  it('sends a row that exists on only one side to the other', () => {
    const plan = planMerge([row('local-only', NOW)], [row('remote-only', NOW)]);
    expect(ids(plan.toUpload)).toEqual(['local-only']);
    expect(ids(plan.toDownload)).toEqual(['remote-only']);
  });

  it('lets the newer edit win, in either direction', () => {
    const plan = planMerge(
      [row('mine-newer', NOW + 1000), row('theirs-newer', NOW)],
      [row('mine-newer', NOW), row('theirs-newer', NOW + 1000)]
    );
    expect(ids(plan.toUpload)).toEqual(['mine-newer']);
    expect(ids(plan.toDownload)).toEqual(['theirs-newer']);
  });

  it('moves nothing when the two sides already agree', () => {
    const plan = planMerge([row('same', NOW)], [row('same', NOW)]);
    expect(plan.toUpload).toEqual([]);
    expect(plan.toDownload).toEqual([]);
  });

  it('treats a deletion as an ordinary edit', () => {
    // This is what makes tombstones necessary: a row that simply vanished
    // locally is indistinguishable from one this device never had, and would
    // come straight back on the next pull.
    const deletedLater = planMerge([row('x', NOW + 1000, NOW + 1000)], [row('x', NOW)]);
    expect(ids(deletedLater.toUpload)).toEqual(['x']);
    expect(deletedLater.toDownload).toEqual([]);

    const undeletedLater = planMerge([row('x', NOW, NOW)], [row('x', NOW + 1000)]);
    expect(ids(undeletedLater.toDownload)).toEqual(['x']);
  });

  it('carries a tombstone to a device that has never seen the row', () => {
    const plan = planMerge([], [row('gone', NOW, NOW)]);
    expect(ids(plan.toDownload)).toEqual(['gone']);
  });

  it('handles an empty side without special-casing', () => {
    expect(planMerge([], [])).toEqual({ toUpload: [], toDownload: [] });
    expect(ids(planMerge([row('a', NOW), row('b', NOW)], []).toUpload)).toEqual(['a', 'b']);
    expect(ids(planMerge([], [row('a', NOW)]).toDownload)).toEqual(['a']);
  });

  it('decides each row on its own, never as a batch', () => {
    const plan = planMerge(
      [row('a', NOW + 1), row('b', NOW), row('c', NOW)],
      [row('a', NOW), row('b', NOW + 1), row('c', NOW)]
    );
    expect(ids(plan.toUpload)).toEqual(['a']);
    expect(ids(plan.toDownload)).toEqual(['b']);
  });
});

describe('planAppendOnlyMerge', () => {
  it('uploads only the rows the remote is missing', () => {
    const plan = planAppendOnlyMerge([row('a', NOW), row('b', NOW)], ['a']);
    expect(ids(plan.toUpload)).toEqual(['b']);
    expect(plan.missingIds).toEqual([]);
  });

  it('names the remote rows worth fetching in full', () => {
    const plan = planAppendOnlyMerge([row('a', NOW)], ['a', 'b', 'c']);
    expect(plan.toUpload).toEqual([]);
    expect(plan.missingIds.sort()).toEqual(['b', 'c']);
  });

  it('never re-fetches or re-sends a row both sides already have', () => {
    // The point of the append-only path: rows are immutable, so a row present
    // on both sides is finished business however old it is.
    const plan = planAppendOnlyMerge([row('a', 1), row('b', 2)], ['a', 'b']);
    expect(plan.toUpload).toEqual([]);
    expect(plan.missingIds).toEqual([]);
  });

  it('ignores updatedAt entirely', () => {
    const plan = planAppendOnlyMerge([row('a', NOW + 999_999)], ['a']);
    expect(plan.toUpload).toEqual([]);
    expect(plan.missingIds).toEqual([]);
  });
});

describe('planIncrementalMerge', () => {
  it('uploads a local row the pull window never mentioned', () => {
    // The whole point: the remote view is partial, so "not in `remote`" cannot
    // mean "the remote does not have it".
    const plan = planIncrementalMerge({
      changedLocal: [row('edited-here', NOW)],
      remote: [],
      localForRemote: [],
    });
    expect(ids(plan.toUpload)).toEqual(['edited-here']);
    expect(plan.toDownload).toEqual([]);
  });

  it('downloads a remote row this device has never had', () => {
    const plan = planIncrementalMerge({
      changedLocal: [],
      remote: [row('from-the-phone', NOW)],
      localForRemote: [],
    });
    expect(ids(plan.toDownload)).toEqual(['from-the-phone']);
    expect(plan.toUpload).toEqual([]);
  });

  it('resolves a row both sides changed, in either direction', () => {
    const remoteWins = planIncrementalMerge({
      changedLocal: [row('x', NOW)],
      remote: [row('x', NOW + 1000)],
      localForRemote: [row('x', NOW)],
    });
    expect(ids(remoteWins.toDownload)).toEqual(['x']);
    expect(remoteWins.toUpload).toEqual([]);

    const localWins = planIncrementalMerge({
      changedLocal: [row('x', NOW + 1000)],
      remote: [row('x', NOW)],
      localForRemote: [row('x', NOW + 1000)],
    });
    expect(ids(localWins.toUpload)).toEqual(['x']);
    expect(localWins.toDownload).toEqual([]);
  });

  it('counts a row appearing in both local sets only once', () => {
    const plan = planIncrementalMerge({
      changedLocal: [row('x', NOW + 1000)],
      remote: [row('x', NOW)],
      localForRemote: [row('x', NOW + 1000)],
    });
    expect(plan.toUpload).toHaveLength(1);
  });

  it('prefers the freshest local read when the two local sets disagree', () => {
    // `localForRemote` is read after `changedLocal`, but a row can be in both;
    // taking the changed-local copy keeps one row winning consistently.
    const plan = planIncrementalMerge({
      changedLocal: [row('x', NOW + 5000)],
      remote: [row('x', NOW + 1000)],
      localForRemote: [row('x', NOW)],
    });
    expect(ids(plan.toUpload)).toEqual(['x']);
  });

  it('leaves alone a row that is in the pull window but identical locally', () => {
    const plan = planIncrementalMerge({
      changedLocal: [],
      remote: [row('x', NOW)],
      localForRemote: [row('x', NOW)],
    });
    expect(plan.toUpload).toEqual([]);
    expect(plan.toDownload).toEqual([]);
  });

  it('carries a remote tombstone down like any other change', () => {
    const plan = planIncrementalMerge({
      changedLocal: [],
      remote: [row('x', NOW + 1000, NOW + 1000)],
      localForRemote: [row('x', NOW)],
    });
    expect(ids(plan.toDownload)).toEqual(['x']);
  });
});

describe('advanceWatermark', () => {
  it('parks short of the newest row it saw', () => {
    expect(advanceWatermark([{ updatedAt: NOW }], 0, 60_000)).toBe(NOW - 60_000);
  });

  it('never moves backwards', () => {
    // An empty batch, or one older than where we already are, must not rewind
    // the cursor — that would re-download the same rows forever.
    expect(advanceWatermark([], NOW, 60_000)).toBe(NOW);
    expect(advanceWatermark([{ updatedAt: NOW - 500_000 }], NOW, 60_000)).toBe(NOW);
  });

  it('stays put when the newest row is inside the slack window', () => {
    expect(advanceWatermark([{ updatedAt: NOW + 1000 }], NOW, 60_000)).toBe(NOW);
  });

  it('takes the newest of the batch, not the last', () => {
    const rows = [{ updatedAt: NOW + 10_000 }, { updatedAt: NOW + 90_000 }, { updatedAt: NOW }];
    expect(advanceWatermark(rows, 0, 60_000)).toBe(NOW + 30_000);
  });

  it('re-examines an overlap, so a row written during the last sync is not skipped', () => {
    const first = advanceWatermark([{ updatedAt: NOW }], 0, 60_000);
    // A device whose clock is 30s behind writes a row stamped NOW - 30_000.
    const laggard = { updatedAt: NOW - 30_000 };
    expect(laggard.updatedAt).toBeGreaterThan(first);
  });
});

describe('missingLocally', () => {
  it('names only the ids with no local row', () => {
    const remoteIds = ['a', 'b', 'c'];
    const local = [{ id: 'a' }, undefined, { id: 'c' }];
    expect(missingLocally(remoteIds, local)).toEqual(['b']);
  });

  it('is empty when everything is already here', () => {
    expect(missingLocally(['a'], [{ id: 'a' }])).toEqual([]);
    expect(missingLocally([], [])).toEqual([]);
  });

  it('names everything when the table is empty', () => {
    expect(missingLocally(['a', 'b'], [undefined, undefined])).toEqual(['a', 'b']);
  });
});
