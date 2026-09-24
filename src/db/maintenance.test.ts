import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import { SWEEP_GRACE_MS, deleteImagesLocally, findUnusedImages, storeImage } from './imageRepository';
import { keepVersion } from './versionRepository';
import { addTextNode, resetDatabase } from '../test/helpers';
import { MAX_EVENTS, clearEvents, formatDiagnostics, getEvents, logError, logEvent, resetDiagnosticsForTest } from '../diagnostics';

beforeEach(resetDatabase);

const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
const imageDoc = (id: string) => JSON.stringify({ type: 'doc', content: [{ type: 'remImage', attrs: { imageId: id } }] });

describe('finding unused images', () => {
  it('counts rems, deleted rems and kept versions as uses, and spares new images', async () => {
    const old = Date.now() - SWEEP_GRACE_MS - 1000;
    const [used, inTombstone, inVersion, unused] = await Promise.all([
      storeImage(png(), old),
      storeImage(png(), old),
      storeImage(png(), old),
      storeImage(png(), old),
    ]);
    const fresh = await storeImage(png());
    await addTextNode('a', '', { content: imageDoc(used.id) });
    await addTextNode('b', '', { content: imageDoc(inTombstone.id), deletedAt: 5 });
    await keepVersion({ id: 'c', content: imageDoc(inVersion.id), plainText: 'x' }, 'edit');

    const found = await findUnusedImages();
    expect(found.ids).toEqual([unused.id]);
    expect(found.ids).not.toContain(fresh.id);
    expect(found.bytes).toBe(4);
    expect(found.uploadedIds).toEqual([]);

    await deleteImagesLocally(found.ids);
    expect(await db.images.get(unused.id)).toBeUndefined();
    expect(await db.images.count()).toBe(4);
  });
});

describe('diagnostics', () => {
  beforeEach(() => {
    resetDiagnosticsForTest();
    clearEvents();
  });

  it('keeps events in order with their detail, and formats them for pasting', () => {
    logEvent('sync', 'Synced', { pushed: 3, pulled: 1 });
    logError('import', new TypeError('bad file'));
    const events = getEvents();
    expect(events.map((e) => [e.area, e.level])).toEqual([
      ['sync', 'info'],
      ['import', 'error'],
    ]);
    const text = formatDiagnostics();
    expect(text).toContain('[sync] Synced pushed=3 pulled=1');
    expect(text).toContain('ERROR [import] TypeError: bad file');
  });

  it(`keeps only the last ${MAX_EVENTS}`, () => {
    for (let i = 0; i < MAX_EVENTS + 20; i++) logEvent('t', `e${i}`);
    const events = getEvents();
    expect(events).toHaveLength(MAX_EVENTS);
    expect(events[0]?.message).toBe('e20');
  });
});
