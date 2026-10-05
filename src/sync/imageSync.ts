import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';
import { cacheRemoteImage, getImage, getPendingUploads, markUploaded } from '../db/imageRepository';
import type { StoredImage } from '../db/schema';
import { activeFileStore, isStoreConfigured, otherFileStores } from './files/fileStoreState';
import { createSupabaseStore } from './files/supabaseStore';
import { FileStoreError, isNeedsSignIn, STORE_LABELS, type FileStore, type FileStoreKind } from './files/types';
import { isSyncConfigured } from './supabaseClient';

/**
 * Moving image and PDF bytes between devices, through a file store — the
 * Supabase bucket or a OneDrive app folder (see `files/types.ts`).
 *
 * Files don't go through the row-by-row table sync: a screenshot is a
 * megabyte, and PostgREST is the wrong pipe for that. Each file is one object
 * named by its id, and:
 *
 * - **Upload is eager**, to this device's chosen store. Every sync sends
 *   whatever this device hasn't sent yet, so an image pasted on the laptop is
 *   there for the phone by the time the rem that shows it arrives.
 * - **Download is lazy**, from the chosen store first and then the other, so
 *   files stay readable while you move from one to the other (or if two
 *   devices disagree about which to use).
 */

export { IMAGE_BUCKET, imagePath } from './files/supabaseStore';

const stores: Partial<Record<FileStoreKind, FileStore>> = {};
/** Stores a test swapped in, which count as set up whatever the build says. */
const testStores = new Set<FileStoreKind>();

/** The store of that kind. `client` is for tests handing in a fake Supabase. */
export function fileStore(kind: FileStoreKind, client?: SupabaseClient): FileStore {
  if (kind === 'supabase' && client) return createSupabaseStore(async () => client);
  const existing = stores[kind];
  if (existing) return existing;
  const created =
    kind === 'supabase' ? createSupabaseStore(getSupabase) : kind === 'onedrive' ? lazyOneDriveStore() : lazyGoogleDriveStore();
  stores[kind] = created;
  return created;
}

/**
 * A store whose code is loaded on first use: the Graph/Drive clients and the
 * sign-in modules stay out of the startup bundle for everyone, and MSAL (a
 * further lazy chunk) out of the download for anyone who never uses OneDrive.
 */
function lazyStore(kind: FileStoreKind, load: () => Promise<FileStore>): FileStore {
  let real: Promise<FileStore> | null = null;
  const get = () =>
    (real ??= load().catch((err: unknown) => {
      real = null;
      throw new FileStoreError('failed', `${kind === 'gdrive' ? 'Google Drive' : 'OneDrive'} couldn’t load: ${err instanceof Error ? err.message : String(err)}`);
    }));
  return {
    kind,
    upload: async (id, data, mime) => (await get()).upload(id, data, mime),
    download: async (id) => (await get()).download(id),
    remove: async (ids) => (await get()).remove(ids),
    list: async () => (await get()).list(),
    usage: async () => (await get()).usage(),
  };
}

function lazyOneDriveStore(): FileStore {
  return lazyStore('onedrive', async () => {
    const [{ createOneDriveStore }, { getOneDriveToken }] = await Promise.all([
      import('./files/oneDriveStore'),
      import('./files/oneDriveAuth'),
    ]);
    return createOneDriveStore({ getToken: getOneDriveToken });
  });
}

function lazyGoogleDriveStore(): FileStore {
  return lazyStore('gdrive', async () => {
    const [{ createGoogleDriveStore }, { getGoogleDriveToken }] = await Promise.all([
      import('./files/googleDriveStore'),
      import('./files/googleDriveAuth'),
    ]);
    return createGoogleDriveStore({ getToken: getGoogleDriveToken });
  });
}

/** Tests: swap a store for a fake (or `null` to go back to the real one). */
export function setFileStoreForTests(kind: FileStoreKind, store: FileStore | null): void {
  if (store) {
    stores[kind] = store;
    testStores.add(kind);
  } else {
    delete stores[kind];
    testStores.delete(kind);
  }
}

/** Can this build use that store at all? */
export function isStoreAvailable(kind: FileStoreKind): boolean {
  if (testStores.has(kind)) return true;
  return kind === 'supabase' ? isSyncConfigured : isStoreConfigured(kind);
}

export interface ImageSyncResult {
  store: FileStoreKind;
  uploaded: number;
  /** Still waiting on this device after this run. */
  pending: number;
  error?: string;
  /** The store is fine; this device has to sign in to it. */
  needsSignIn?: boolean;
}

/** Send every file this device hasn't uploaded yet, to its chosen store. */
export async function uploadPendingImages(_userId: string, client?: SupabaseClient): Promise<ImageSyncResult> {
  const kind = activeFileStore();
  const pending = await getPendingUploads();
  // Nothing to send: don't wake MSAL or supabase-js for nothing.
  if (pending.length === 0) return { store: kind, uploaded: 0, pending: 0 };
  if (kind === 'supabase' && !client && !(await getSupabase())) {
    return { store: kind, uploaded: 0, pending: pending.length };
  }

  const store = fileStore(kind, kind === 'supabase' ? client : undefined);
  let uploaded = 0;
  for (const image of pending) {
    try {
      await store.upload(image.id, image.data, image.mime);
    } catch (err) {
      // One failure is almost always all of them (no bucket, signed out,
      // offline) — stop rather than repeat it for every file on every poll.
      return {
        store: kind,
        uploaded,
        pending: pending.length - uploaded,
        error: err instanceof Error ? err.message : String(err),
        needsSignIn: isNeedsSignIn(err),
      };
    }
    await markUploaded(image.id);
    uploaded += 1;
  }
  return { store: kind, uploaded, pending: 0 };
}

/** In-flight fetches, so ten rems showing one image make one request. */
const inFlight = new Map<string, Promise<LoadResult>>();

export interface LoadResult {
  image?: StoredImage;
  /** Stores that might have had it but need this device to sign in first. */
  needsSignIn: FileStoreKind[];
}

/**
 * The file, from this device if it has it, otherwise from cloud storage (and
 * kept), trying the chosen store first and then the other.
 */
export async function loadImageWithReason(imageId: string): Promise<LoadResult> {
  const local = await getImage(imageId);
  if (local) return { image: local, needsSignIn: [] };

  const existing = inFlight.get(imageId);
  if (existing) return existing;

  const job = (async (): Promise<LoadResult> => {
    const needsSignIn: FileStoreKind[] = [];
    const first = activeFileStore();
    const order = [first, ...otherFileStores(first)].filter(isStoreAvailable);
    try {
      for (const kind of order) {
        try {
          const blob = await fileStore(kind).download(imageId);
          if (blob) return { image: await cacheRemoteImage(imageId, blob), needsSignIn };
        } catch (err) {
          if (isNeedsSignIn(err)) needsSignIn.push(kind);
          // Otherwise (offline, not configured): try the next store.
        }
      }
      return { needsSignIn };
    } finally {
      inFlight.delete(imageId);
    }
  })();
  inFlight.set(imageId, job);
  return job;
}

/** `loadImageWithReason`, for callers that only want the file. */
export async function loadImage(imageId: string): Promise<StoredImage | undefined> {
  return (await loadImageWithReason(imageId)).image;
}

/**
 * Delete files from cloud storage — from every store this build uses, since
 * a file may be in either. Returns how many went, or why some couldn't.
 */
export async function removeFromStorage(imageIds: string[]): Promise<{ removed: number; error?: string }> {
  if (imageIds.length === 0) return { removed: 0 };
  let removed = 0;
  const problems: string[] = [];
  for (const kind of ['supabase', 'onedrive', 'gdrive'] as const) {
    if (!isStoreAvailable(kind)) continue;
    try {
      removed = Math.max(removed, await fileStore(kind).remove(imageIds));
    } catch (err) {
      if (err instanceof FileStoreError && err.code === 'not-configured') continue;
      const where = STORE_LABELS[kind];
      problems.push(
        isNeedsSignIn(err)
          ? `Not signed in to ${where} here, so copies there were left alone.`
          : `${where}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return problems.length ? { removed, error: problems.join(' ') } : { removed };
}
