import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import {
  ImageTooLargeError,
  MAX_BYTES,
  cacheRemoteImage,
  getImage,
  getPendingUploads,
  markUploaded,
  storeImage,
} from './imageRepository';
import { createPage } from './repository';
import { resetDatabase, childOrder } from '../test/helpers';
import { base64ToBytes, buildBackup, bytesToBase64, serializeBackup } from '../export/backup';
import { importBackup, parseBackup } from '../export/importBackup';
import { pagesToMarkdown } from '../export/markdown';
import { buildExportTrees } from '../export/tree';
import { imagePath } from '../sync/imageSync';

beforeEach(resetDatabase);

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 250, 251, 252]);
const png = () => new Blob([PNG_BYTES], { type: 'image/png' });
const bytesOf = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)];

describe('storing an image', () => {
  it('keeps the bytes and type, and marks it as still to upload', async () => {
    const stored = await storeImage(png());
    const read = await getImage(stored.id);
    expect(read?.mime).toBe('image/png');
    expect(bytesOf(read!.data)).toEqual([...PNG_BYTES]);
    expect(read?.size).toBe(PNG_BYTES.length);
    expect((await getPendingUploads()).map((i) => i.id)).toEqual([stored.id]);
  });

  it('stops counting as pending once uploaded', async () => {
    const stored = await storeImage(png());
    await markUploaded(stored.id);
    expect(await getPendingUploads()).toEqual([]);
  });

  it('refuses something that is not an image', async () => {
    await expect(storeImage(new Blob(['hi'], { type: 'text/plain' }))).rejects.toThrow(/isn't an image/);
  });

  it('refuses an enormous file with a message saying how big', async () => {
    const huge = { type: 'image/png', size: MAX_BYTES + 1 } as Blob;
    await expect(storeImage(huge)).rejects.toBeInstanceOf(ImageTooLargeError);
  });

  it('caches an image fetched from another device as already uploaded', async () => {
    await cacheRemoteImage('from-phone', png());
    expect((await getImage('from-phone'))?.uploadedAt).toBeGreaterThan(0);
    expect(await getPendingUploads()).toEqual([]);
  });

  it('files each image under its owner in cloud storage', () => {
    expect(imagePath('user-1', 'img-1')).toBe('user-1/img-1');
  });
});

describe('images in backups', () => {
  it('round-trips arbitrary bytes through base64', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(bytesOf(base64ToBytes(bytesToBase64(all.buffer)))).toEqual([...all]);
  });

  it('writes the pixels into the file, not an empty object', async () => {
    await storeImage(png());
    const text = serializeBackup(await buildBackup());
    const file = JSON.parse(text);
    expect(typeof file.data.images[0].data).toBe('string');
    expect(file.counts.images).toBe(1);
  });

  it('restores the same bytes, and re-queues them for upload on this device', async () => {
    const stored = await storeImage(png());
    await markUploaded(stored.id);
    const text = serializeBackup(await buildBackup());

    await db.images.clear();
    await importBackup(parseBackup(text), 'merge');

    const restored = await getImage(stored.id);
    expect(bytesOf(restored!.data)).toEqual([...PNG_BYTES]);
    expect(restored?.uploadedAt).toBe(0);
  });

  it('rejects an image row with no data', () => {
    const bad = {
      format: 'clemnotes-backup',
      formatVersion: 1,
      data: { images: [{ id: 'x', updatedAt: 1, deletedAt: null }] },
    };
    expect(() => parseBackup(JSON.stringify(bad))).toThrow(/no data/);
  });

  it('still reads a backup made before images existed', () => {
    const old = { format: 'clemnotes-backup', formatVersion: 1, schemaVersion: 11, data: { nodes: [] } };
    expect(parseBackup(JSON.stringify(old)).data.images).toEqual([]);
  });
});

describe('images in Markdown', () => {
  it('keep their place and their id', async () => {
    const page = await createPage('Diagrams');
    await db.nodes.update((await childOrder(page.id))[0]!, {
      content: JSON.stringify({
        type: 'doc',
        content: [{ type: 'remImage', attrs: { imageId: 'img-1', alt: '', size: 'full' } }],
      }),
    });
    expect(pagesToMarkdown(await buildExportTrees())).toContain('![image](clemnotes-image:img-1)');
  });
});
