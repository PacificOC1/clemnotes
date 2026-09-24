import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import { deleteRowsForGood, purgeLocalTombstones } from './tombstones';
import { keepVersion } from './versionRepository';
import { addTextNode, cardLike, resetDatabase } from '../test/helpers';
import { planPurges, TOMBSTONE_RETENTION_MS } from '../sync/merge';

beforeEach(resetDatabase);

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const row = (id: string, deletedAt: number | null = null, updatedAt = NOW - 200 * DAY) => ({ id, deletedAt, updatedAt });

describe('which rows the cloud has purged (#24)', () => {
  it('drops old tombstones and rows the cloud had and dropped; uploads everything else', () => {
    const { purge, refused } = planPurges({
      missingRemotely: [
        row('old-tombstone', NOW - 100 * DAY),
        row('young-tombstone', NOW - 10 * DAY),
        row('agreed-then-gone'),
        row('never-agreed'),
      ],
      agreedUnchanged: new Set(['agreed-then-gone']),
      now: NOW,
      localCount: 1000,
      remoteCount: 900,
    });
    expect(refused).toBe(false);
    expect(purge.map((r) => r.id).sort()).toEqual(['agreed-then-gone', 'old-tombstone']);
  });

  it('refuses to treat a wiped cloud table as a mass purge', () => {
    const agreed = Array.from({ length: 400 }, (_, i) => row(`r${i}`));
    const emptyRemote = planPurges({
      missingRemotely: [...agreed, row('old-tombstone', NOW - 100 * DAY)],
      agreedUnchanged: new Set(agreed.map((r) => r.id)),
      now: NOW,
      localCount: 401,
      remoteCount: 0,
    });
    expect(emptyRemote.refused).toBe(true);
    // Old tombstones are deletions either way, so they still go.
    expect(emptyRemote.purge.map((r) => r.id)).toEqual(['old-tombstone']);

    const mostlyGone = planPurges({
      missingRemotely: agreed,
      agreedUnchanged: new Set(agreed.map((r) => r.id)),
      now: NOW,
      localCount: 1000,
      remoteCount: 600,
    });
    expect(mostlyGone.refused).toBe(true);
    expect(mostlyGone.purge).toEqual([]);
  });

  it('uses a 90-day window', () => {
    expect(TOMBSTONE_RETENTION_MS).toBe(90 * DAY);
  });
});

describe('deleting for good', () => {
  it('takes a rem’s cards, versions and sync base with it', async () => {
    const rem = await addTextNode('rem', 'Gone', { deletedAt: NOW - 100 * DAY });
    await addTextNode('kept', 'Kept');
    await db.cards.add(cardLike({ id: 'rem::forward', nodeId: 'rem' }));
    await db.cards.add(cardLike({ id: 'kept::forward', nodeId: 'kept' }));
    await keepVersion(rem, 'restore');
    await db.syncBase.put({ id: 'rem', row: rem });

    await deleteRowsForGood('nodes', ['rem']);

    expect(await db.nodes.get('rem')).toBeUndefined();
    expect(await db.cards.get('rem::forward')).toBeUndefined();
    expect(await db.cards.get('kept::forward')).toBeDefined();
    expect(await db.versions.count()).toBe(0);
    expect(await db.syncBase.get('rem')).toBeUndefined();
  });

  it('purges a local-only notebook’s own old tombstones, and nothing younger', async () => {
    await addTextNode('old', 'old', { deletedAt: NOW - 100 * DAY });
    await addTextNode('young', 'young', { deletedAt: NOW - 5 * DAY });
    await addTextNode('live', 'live');
    await db.dictionary.add({ id: 'd', word: 'w', displayWord: 'w', definition: '', deletedAt: NOW - 120 * DAY, createdAt: 0, updatedAt: 0 });

    expect(await purgeLocalTombstones(NOW)).toBe(2);
    expect((await db.nodes.toArray()).map((n) => n.id).sort()).toEqual(['live', 'young']);
    expect(await db.dictionary.count()).toBe(0);
  });
});
