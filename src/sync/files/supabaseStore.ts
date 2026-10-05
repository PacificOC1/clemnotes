import type { SupabaseClient } from '@supabase/supabase-js';
import { withSniffedType } from './sniff';
import { FileStoreError, type FileStore, type RemoteFile } from './types';

/**
 * Files in the private `images` bucket of your Supabase project, at
 * `<userId>/<fileId>` (bucket and access rules: `migration-005-images.sql`).
 */

export const IMAGE_BUCKET = 'images';

export function imagePath(userId: string, imageId: string): string {
  return `${userId}/${imageId}`;
}

/** Supabase's free plan. The API can't tell us the real plan, so the meter says "free plan". */
export const SUPABASE_FREE_STORAGE_BYTES = 1_000_000_000;

const PAGE = 1000;

export function createSupabaseStore(getClient: () => Promise<SupabaseClient | null>): FileStore {
  async function signedIn(): Promise<{ client: SupabaseClient; userId: string }> {
    const client = await getClient();
    if (!client) throw new FileStoreError('not-configured', 'Cloud sync is not configured.');
    const { data } = await client.auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) throw new FileStoreError('needs-sign-in', 'Sign in to sync first.');
    return { client, userId };
  }

  async function list(): Promise<RemoteFile[]> {
    const { client, userId } = await signedIn();
    const files: RemoteFile[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await client.storage.from(IMAGE_BUCKET).list(userId, { limit: PAGE, offset });
      if (error) throw new FileStoreError('failed', error.message);
      for (const item of data ?? []) {
        // Folders come back with a null id; the placeholder is Supabase's own.
        if (!item.id || item.name === '.emptyFolderPlaceholder') continue;
        const size = Number((item.metadata as { size?: number } | null)?.size ?? 0);
        files.push({ id: item.name, size });
      }
      if (!data || data.length < PAGE) break;
    }
    return files;
  }

  return {
    kind: 'supabase',

    async upload(id, data, mime) {
      const { client, userId } = await signedIn();
      const { error } = await client.storage
        .from(IMAGE_BUCKET)
        .upload(imagePath(userId, id), new Blob([data], { type: mime }), {
          contentType: mime,
          // Ids are unique, so an existing object is an earlier upload of the same bytes.
          upsert: true,
        });
      if (error) throw new FileStoreError('failed', error.message);
    },

    async download(id) {
      const { client, userId } = await signedIn();
      const { data, error } = await client.storage.from(IMAGE_BUCKET).download(imagePath(userId, id));
      if (error || !data) return null;
      return withSniffedType(data);
    },

    async remove(ids) {
      if (ids.length === 0) return 0;
      const { client, userId } = await signedIn();
      for (let i = 0; i < ids.length; i += PAGE) {
        const chunk = ids.slice(i, i + PAGE);
        const { error } = await client.storage.from(IMAGE_BUCKET).remove(chunk.map((id) => imagePath(userId, id)));
        if (error) throw new FileStoreError('failed', error.message);
      }
      return ids.length;
    },

    list,

    async usage() {
      const files = await list();
      return {
        files: files.length,
        filesBytes: files.reduce((sum, file) => sum + file.size, 0),
        quota: null,
      };
    },
  };
}
