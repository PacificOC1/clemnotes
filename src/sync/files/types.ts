/**
 * Where image and PDF bytes live in the cloud.
 *
 * Rows (rems, cards, reviews…) always sync through Supabase's tables. The
 * *bytes* behind images and PDFs can go to one of two places:
 *
 * - `supabase` — the private `images` bucket in your Supabase project
 *   (1 GB on the free plan).
 * - `onedrive` — the app's own folder in a Microsoft OneDrive, personal or
 *   work/school (`Apps/<app name>`). Clemnotes can't see anything else there.
 * - `gdrive` — the hidden app-data folder in a Google Drive. Invisible in
 *   Drive itself, and Clemnotes can't see your other files.
 *
 * Every store holds each file under its id, so the same file can be found in
 * either one — which is what lets a device read from both while you move from
 * one to the other.
 */

export type FileStoreKind = 'supabase' | 'onedrive' | 'gdrive';

export interface RemoteFile {
  id: string;
  size: number;
}

export interface StoreUsage {
  /** Bytes Clemnotes' files take up in this store. */
  filesBytes: number;
  files: number;
  /** The whole account's quota, when the store can tell us; otherwise null. */
  quota: { used: number; total: number } | null;
}

export interface FileStore {
  kind: FileStoreKind;
  /** Put a file, replacing any earlier copy with the same id. */
  upload(id: string, data: ArrayBuffer, mime: string): Promise<void>;
  /** The file, or `null` when this store doesn't have it. */
  download(id: string): Promise<Blob | null>;
  /** Delete files; ids that aren't there count as done. Returns how many went. */
  remove(ids: string[]): Promise<number>;
  /** Every file in the store. */
  list(): Promise<RemoteFile[]>;
  usage(): Promise<StoreUsage>;
}

export type FileStoreErrorCode =
  /** The store is fine, but this device has to sign in (again) to use it. */
  | 'needs-sign-in'
  /** Nothing to talk to: sync or OneDrive isn't set up in this build. */
  | 'not-configured'
  | 'failed';

export class FileStoreError extends Error {
  readonly code: FileStoreErrorCode;
  constructor(code: FileStoreErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'FileStoreError';
  }
}

export function isNeedsSignIn(err: unknown): boolean {
  return err instanceof FileStoreError && err.code === 'needs-sign-in';
}

export const STORE_LABELS: Record<FileStoreKind, string> = {
  supabase: 'Supabase Storage',
  onedrive: 'OneDrive',
  gdrive: 'Google Drive',
};
