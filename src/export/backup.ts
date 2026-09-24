import { db } from '../db/database';
import type {
  DictionaryEntry,
  Flashcard,
  OutlinerNode,
  PageFolder,
  ReviewLogEntry,
  StoredImage,
} from '../db/schema';

/**
 * A complete, lossless copy of the database as one JSON file.
 *
 * The point of this file is that it is the only thing standing between you and
 * losing everything: until it existed, the notes lived in one browser's
 * IndexedDB and one Supabase project, and there was no way to inspect them,
 * move them, or leave. It is also the safety net under every risky change —
 * schema migrations, the `childrenIds` removal, conflict-resolution work —
 * which is why it was worth building before any of them.
 *
 * Two decisions worth knowing about:
 *
 * - **Tombstones are included.** Soft-deleted rows are part of the state, not
 *   noise: dropping them would mean that restoring a backup on a device that
 *   still holds a deleted rem would resurrect it on the next sync. A backup
 *   that quietly undeletes things is worse than no backup.
 * - **Content is stored exactly as the database holds it** — the Tiptap JSON
 *   string, untouched. No prettifying, no re-serialising. A restore has to
 *   produce byte-identical rems, and the surest way to do that is not to
 *   transform them on the way out.
 */

export const BACKUP_FORMAT = 'clemnotes-backup' as const;

/**
 * Bumped only when the *envelope* changes in a way an importer must know
 * about. Adding a field to a row does not need a bump — the importer copies
 * rows through as they are.
 */
export const BACKUP_FORMAT_VERSION = 1;

/**
 * The Dexie version this build writes; recorded so a restore can warn about a
 * mismatch. Read off the database definition rather than restated, so the two
 * cannot drift the next time a version is added.
 */
export const CURRENT_SCHEMA_VERSION = db.verno;

export interface BackupTables {
  nodes: OutlinerNode[];
  cards: Flashcard[];
  reviews: ReviewLogEntry[];
  dictionary: DictionaryEntry[];
  folders: PageFolder[];
  /**
   * In memory, bytes as an `ArrayBuffer`, exactly as IndexedDB holds them. In
   * the file, base64 — see `serializeBackup` and `decodeImageRow`.
   */
  images: StoredImage[];
}

export type BackupTableName = keyof BackupTables;

export const BACKUP_TABLES: BackupTableName[] = [
  'nodes',
  'cards',
  'reviews',
  'dictionary',
  'folders',
  'images',
];

// ---------------------------------------------------------------- base64

/** Bytes → base64, in chunks: spreading a megabyte into `fromCharCode` overflows the stack. */
export function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  /** Dexie schema version of the database this came out of. */
  schemaVersion: number;
  exportedAt: number;
  /** Row counts, so a file can be sanity-checked without parsing all of it by eye. */
  counts: Record<BackupTableName, number>;
  data: BackupTables;
}

/** Read every table into a backup envelope. */
export async function buildBackup(now = Date.now()): Promise<BackupFile> {
  const [nodes, cards, reviews, dictionary, folders, images] = await Promise.all([
    db.nodes.toArray(),
    db.cards.toArray(),
    db.reviews.toArray(),
    db.dictionary.toArray(),
    db.folders.toArray(),
    db.images.toArray(),
  ]);

  const data: BackupTables = { nodes, cards, reviews, dictionary, folders, images };

  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: now,
    counts: countRows(data),
    data,
  };
}

/**
 * Wrap raw tables — from a migration snapshot, say — in the backup envelope,
 * so they can be downloaded and restored with the ordinary importer.
 *
 * A table the source database did not have yet comes out empty, which the
 * importer already reads as "nothing to restore for that table".
 */
export async function backupFromTables(
  tables: Record<string, unknown[]>,
  schemaVersion: number,
  exportedAt: number
): Promise<BackupFile> {
  const pick = <K extends BackupTableName>(name: K) =>
    (Array.isArray(tables[name]) ? tables[name] : []) as BackupTables[K];
  const data: BackupTables = {
    nodes: pick('nodes'),
    cards: pick('cards'),
    reviews: pick('reviews'),
    dictionary: pick('dictionary'),
    folders: pick('folders'),
    images: pick('images'),
  };
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion,
    exportedAt,
    counts: countRows(data),
    data,
  };
}

export function countRows(data: BackupTables): Record<BackupTableName, number> {
  return {
    nodes: data.nodes.length,
    cards: data.cards.length,
    reviews: data.reviews.length,
    dictionary: data.dictionary.length,
    folders: data.folders.length,
    images: data.images.length,
  };
}

/**
 * Serialise a backup.
 *
 * Image bytes become base64 here and nowhere else — `JSON.stringify` would
 * otherwise write an `ArrayBuffer` as `{}` and the backup would hold every
 * image's size and none of its pixels.
 *
 * Indented rather than minified on purpose: a backup you cannot open in a text
 * editor and read is a backup you cannot check, and gzip flattens the size
 * difference anyway.
 */
export function serializeBackup(backup: BackupFile): string {
  const images = backup.data.images.map((image) => ({ ...image, data: bytesToBase64(image.data) }));
  return `${JSON.stringify({ ...backup, data: { ...backup.data, images } }, null, 2)}\n`;
}

export function backupFilename(now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `clemnotes-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

/** How many rows in a backup are live (not tombstoned) — what the UI should quote. */
export function liveCounts(data: BackupTables): Record<BackupTableName, number> {
  const live = <T extends { deletedAt: number | null }>(rows: T[]) =>
    rows.filter((r) => r.deletedAt === null).length;
  return {
    nodes: live(data.nodes),
    cards: live(data.cards),
    reviews: live(data.reviews),
    dictionary: live(data.dictionary),
    folders: live(data.folders),
    images: live(data.images),
  };
}
