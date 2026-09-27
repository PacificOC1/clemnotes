import { v4 as uuid } from 'uuid';
import { db } from './database';
import type { StoredImage } from './schema';

/**
 * Images: the bytes behind every picture in a rem.
 *
 * A rem's doc holds an `imageId`, never a URL or the image itself. That keeps
 * the doc small — it is synced and rewritten on every keystroke — and keeps
 * the app local-first: the picture renders from IndexedDB with no network,
 * and cloud storage is where other devices *fetch* it from, not where it
 * lives.
 */

/** Past this on its longest side, a photo is shrunk before it is stored. */
export const MAX_DIMENSION = 2400;
/** Past this many bytes, a raster image is re-encoded even if it is small in pixels. */
export const SHRINK_ABOVE_BYTES = 1_500_000;
/** Refused outright — a file this big is almost certainly not meant for a note. */
export const MAX_BYTES = 25_000_000;

const SHRINKABLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp']);

export class ImageTooLargeError extends Error {}

interface Prepared {
  data: ArrayBuffer;
  mime: string;
  width: number | null;
  height: number | null;
}

/**
 * Shrink a photo that is far bigger than a note needs, in the browser.
 *
 * Only raster formats that re-encode losslessly enough to be worth it: an SVG
 * is already small and scales, and a GIF would lose its animation. Where the
 * browser has no canvas (the tests, an old WebView), the image is stored as
 * it came.
 */
async function prepare(file: Blob): Promise<Prepared> {
  const mime = file.type || 'application/octet-stream';
  const original = await file.arrayBuffer();

  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return { data: original, mime, width: null, height: null };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // SVG and a few others can't become a bitmap from a Blob; keep them as is.
    return { data: original, mime, width: null, height: null };
  }

  const { width, height } = bitmap;
  const longest = Math.max(width, height);
  const needsShrink =
    SHRINKABLE.has(mime) && (longest > MAX_DIMENSION || original.byteLength > SHRINK_ABOVE_BYTES);

  if (!needsShrink) {
    bitmap.close();
    return { data: original, mime, width, height };
  }

  const scale = Math.min(1, MAX_DIMENSION / longest);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return { data: original, mime, width, height };
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.88));
  // Keep the original when re-encoding didn't actually help — a small PNG of
  // flat colour can come out *bigger* as WebP.
  if (!blob || blob.size >= original.byteLength) {
    return { data: original, mime, width, height };
  }
  return { data: await blob.arrayBuffer(), mime: 'image/webp', width: canvas.width, height: canvas.height };
}

/** PDFs are kept whole — they are the source you read — up to what cloud storage takes. */
export const MAX_PDF_BYTES = 50_000_000;

/**
 * Store a PDF (#53) in the same table as images: the same local-first bytes,
 * the same upload to the private bucket, the same backup and clean-up.
 */
export async function storePdf(file: Blob, now = Date.now()): Promise<StoredImage> {
  if (file.type && file.type !== 'application/pdf') throw new Error("That isn't a PDF.");
  if (file.size > MAX_PDF_BYTES) {
    throw new ImageTooLargeError(
      `That PDF is ${(file.size / 1_000_000).toFixed(0)} MB — the limit is ${MAX_PDF_BYTES / 1_000_000} MB.`
    );
  }
  const data = await file.arrayBuffer();
  const stored: StoredImage = {
    id: uuid(),
    mime: 'application/pdf',
    data,
    width: null,
    height: null,
    size: data.byteLength,
    uploadedAt: 0,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.images.add(stored);
  return stored;
}

/** Store an image and return its id — what the doc will refer to. */
export async function storeImage(file: Blob, now = Date.now()): Promise<StoredImage> {
  if (!file.type.startsWith('image/')) throw new Error("That isn't an image.");
  if (file.size > MAX_BYTES) {
    throw new ImageTooLargeError(
      `That image is ${(file.size / 1_000_000).toFixed(0)} MB — the limit is ${MAX_BYTES / 1_000_000} MB.`
    );
  }

  const prepared = await prepare(file);
  const image: StoredImage = {
    id: uuid(),
    mime: prepared.mime,
    data: prepared.data,
    width: prepared.width,
    height: prepared.height,
    size: prepared.data.byteLength,
    uploadedAt: 0,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.images.add(image);
  return image;
}

export async function getImage(id: string): Promise<StoredImage | undefined> {
  const image = await db.images.get(id);
  return image && !image.deletedAt ? image : undefined;
}

/** Put bytes fetched from another device's upload into the local store. */
export async function cacheRemoteImage(id: string, blob: Blob, now = Date.now()): Promise<StoredImage> {
  const data = await blob.arrayBuffer();
  const image: StoredImage = {
    id,
    mime: blob.type || 'application/octet-stream',
    data,
    width: null,
    height: null,
    size: data.byteLength,
    // It came *from* cloud storage, so there is nothing to send back.
    uploadedAt: now,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.images.put(image);
  return image;
}

/** Images this device has not yet put in cloud storage. */
export async function getPendingUploads(): Promise<StoredImage[]> {
  const rows = await db.images.where('uploadedAt').equals(0).toArray();
  return rows.filter((row) => !row.deletedAt);
}

export async function markUploaded(id: string, now = Date.now()): Promise<void> {
  await db.images.update(id, { uploadedAt: now });
}

/** Images this new are never swept — another device may be mid-paste. */
export const SWEEP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface UnusedImages {
  ids: string[];
  bytes: number;
  /** Of those, the ones this device knows are in cloud storage. */
  uploadedIds: string[];
}

function collectImageIds(content: string, into: Set<string>): void {
  // Cheaper than parsing every doc: stored files are only ever referred to by
  // these attrs — `imageId` on a picture, `fileId` on a PDF block or on a
  // highlight's page chip (#53).
  for (const match of content.matchAll(/"(?:imageId|fileId)":"([^"]+)"/g)) into.add(match[1]!);
}

/**
 * Images nothing refers to any more. "Refers to" is generous on purpose: a
 * deleted rem (which undo or a restore could bring back) and every kept
 * version of every rem count, so cleaning up can never break something you
 * could still get back.
 */
export async function findUnusedImages(now = Date.now()): Promise<UnusedImages> {
  const referenced = new Set<string>();
  await db.nodes.each((node) => collectImageIds(node.content, referenced));
  await db.versions.each((version) => collectImageIds(version.content, referenced));

  const ids: string[] = [];
  const uploadedIds: string[] = [];
  let bytes = 0;
  await db.images.each((image) => {
    if (referenced.has(image.id) || now - image.createdAt < SWEEP_GRACE_MS) return;
    ids.push(image.id);
    bytes += image.size;
    if (image.uploadedAt > 0) uploadedIds.push(image.id);
  });
  return { ids, bytes, uploadedIds };
}

/** Remove images from this browser. (Cloud copies: `removeFromStorage` in imageSync.) */
export async function deleteImagesLocally(ids: string[]): Promise<void> {
  if (ids.length > 0) await db.images.bulkDelete(ids);
}
