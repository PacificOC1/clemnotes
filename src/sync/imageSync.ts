import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';
import { cacheRemoteImage, getImage, getPendingUploads, markUploaded } from '../db/imageRepository';
import type { StoredImage } from '../db/schema';

/**
 * Moving image bytes between devices, through Supabase Storage.
 *
 * Images don't go through the row-by-row table sync: a screenshot is a
 * megabyte, and PostgREST is the wrong pipe for that. Instead each image is
 * one object in a private `images` bucket at `<userId>/<imageId>`, and:
 *
 * - **Upload is eager.** Every sync sends whatever this device has that it
 *   hasn't sent yet, so an image pasted on the laptop is there for the phone
 *   by the time the rem that shows it arrives.
 * - **Download is lazy.** A device fetches an image the first time a rem
 *   showing it is drawn, and keeps it. A notebook with years of screenshots
 *   doesn't make a new device download all of them to show one page.
 *
 * The bucket and its access rules come from `supabase/migration-005-images.sql`.
 * Until that has been run, uploads fail, the sidebar says which file to run,
 * and images still work on the device they were pasted on.
 *
 * **Not exercised against a live project** — the calls are the documented
 * supabase-js storage API, and everything around them is tested, but nothing
 * here has talked to a real bucket yet.
 */

export const IMAGE_BUCKET = 'images';

export function imagePath(userId: string, imageId: string): string {
  return `${userId}/${imageId}`;
}

export interface ImageSyncResult {
  uploaded: number;
  error?: string;
}

/** Send every image this device hasn't uploaded yet. */
export async function uploadPendingImages(userId: string, client?: SupabaseClient): Promise<ImageSyncResult> {
  const supabase = client ?? (await getSupabase());
  if (!supabase) return { uploaded: 0 };
  const pending = await getPendingUploads();
  let uploaded = 0;

  for (const image of pending) {
    const { error } = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(imagePath(userId, image.id), new Blob([image.data], { type: image.mime }), {
        contentType: image.mime,
        // Ids are unique, so the only way the object already exists is an
        // earlier upload that succeeded but wasn't recorded. Same bytes.
        upsert: true,
      });
    if (error) {
      // One failure is almost always all of them (no bucket, no policy) —
      // stop rather than repeat it for every image on every poll.
      return { uploaded, error: error.message };
    }
    await markUploaded(image.id);
    uploaded += 1;
  }

  return { uploaded };
}

/** In-flight fetches, so ten rems showing one image make one request. */
const inFlight = new Map<string, Promise<StoredImage | undefined>>();

/**
 * The image, from this device if it has it, otherwise from cloud storage
 * (and kept). `undefined` when neither has it — signed out, offline, or an
 * image whose upload never finished on the device it came from.
 */
export async function loadImage(imageId: string): Promise<StoredImage | undefined> {
  const local = await getImage(imageId);
  if (local) return local;
  const supabase = await getSupabase();
  if (!supabase) return undefined;

  const existing = inFlight.get(imageId);
  if (existing) return existing;

  const client = supabase;
  const job = (async () => {
    try {
      const { data: session } = await client.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) return undefined;
      const { data, error } = await client.storage.from(IMAGE_BUCKET).download(imagePath(userId, imageId));
      if (error || !data) return undefined;
      return await cacheRemoteImage(imageId, data);
    } catch {
      return undefined;
    } finally {
      inFlight.delete(imageId);
    }
  })();
  inFlight.set(imageId, job);
  return job;
}

/** Delete images from cloud storage. Returns how many went, or an error message. */
export async function removeFromStorage(imageIds: string[]): Promise<{ removed: number; error?: string }> {
  const supabase = imageIds.length > 0 ? await getSupabase() : null;
  if (!supabase) return { removed: 0 };
  const { data: session } = await supabase.auth.getSession();
  const userId = session.session?.user.id;
  if (!userId) return { removed: 0, error: 'Not signed in, so cloud copies were left alone.' };
  const { error } = await supabase.storage.from(IMAGE_BUCKET).remove(imageIds.map((id) => imagePath(userId, id)));
  return error ? { removed: 0, error: error.message } : { removed: imageIds.length };
}
