import { getImage } from '../../db/imageRepository';
import { logEvent } from '../../diagnostics';
import { sniffMime } from './sniff';
import type { FileStore } from './types';

/**
 * Move every file from one store to another — Supabase → OneDrive, or back,
 * or college OneDrive → personal OneDrive via Supabase.
 *
 * One file at a time: copy it over (from this device's copy when it has one,
 * so nothing is downloaded twice), and only once the copy has landed delete
 * the original. Stopping half-way — closing the tab, going offline — loses
 * nothing: the next run lists what is still in the old store and carries on.
 * Other devices keep finding each file throughout, because reads try both
 * stores.
 */

export interface MoveProgress {
  done: number;
  total: number;
  bytes: number;
}

export interface MoveResult extends MoveProgress {
  /** Files the old store listed but wouldn't hand over. Left where they were. */
  skipped: number;
  error?: string;
}

export async function moveFiles(
  from: FileStore,
  to: FileStore,
  onProgress?: (progress: MoveProgress) => void,
  isCancelled?: () => boolean
): Promise<MoveResult> {
  const files = await from.list();
  const progress: MoveProgress = { done: 0, total: files.length, bytes: 0 };
  let skipped = 0;
  onProgress?.({ ...progress });

  for (const file of files) {
    if (isCancelled?.()) break;
    try {
      const local = await getImage(file.id);
      let data: ArrayBuffer;
      let mime: string;
      if (local) {
        data = local.data;
        mime = local.mime;
      } else {
        const blob = await from.download(file.id);
        if (!blob) {
          skipped += 1;
          continue;
        }
        data = await blob.arrayBuffer();
        mime = blob.type || sniffMime(new Uint8Array(data));
      }
      await to.upload(file.id, data, mime);
      await from.remove([file.id]);
      progress.done += 1;
      progress.bytes += data.byteLength;
      onProgress?.({ ...progress });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logEvent('files', `Moving files stopped: ${error}`, { done: progress.done, total: progress.total }, 'warn');
      return { ...progress, skipped, error };
    }
  }

  logEvent('files', `Moved files ${from.kind} → ${to.kind}`, { done: progress.done, total: progress.total, skipped, bytes: progress.bytes });
  return { ...progress, skipped };
}
