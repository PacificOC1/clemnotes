import { db } from '../db/database';
import { invalidateSearchIndex } from '../db/searchIndex';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
  CURRENT_SCHEMA_VERSION,
  type BackupFile,
  type BackupTableName,
  type BackupTables,
} from './backup';

/**
 * Restoring a backup.
 *
 * An export that cannot be imported is a museum piece, so this deliberately
 * round-trips the exporter's own output exactly: parse, validate, write back,
 * and end up with the database you started from.
 */

export type ImportMode = 'merge' | 'replace';

export interface TableImportResult {
  table: BackupTableName;
  added: number;
  updated: number;
  /** Rows skipped because what's already here is newer. */
  kept: number;
}

export interface ImportReport {
  mode: ImportMode;
  tables: TableImportResult[];
  added: number;
  updated: number;
  kept: number;
}

export class BackupParseError extends Error {}

interface UnknownRow {
  id?: unknown;
  updatedAt?: unknown;
  deletedAt?: unknown;
}

/**
 * Parse and validate a backup file.
 *
 * The checks are deliberately about the *envelope* rather than every field: a
 * file that says it is a Clemnotes backup, at a format version we understand,
 * with rows that carry the three fields everything downstream relies on (`id`,
 * `updatedAt`, `deletedAt`) is safe to write. Rejecting on anything stricter
 * would mean a backup taken today stops importing the first time a field is
 * added to a row.
 */
export function parseBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupParseError("That file isn't valid JSON — is it definitely a Clemnotes backup?");
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new BackupParseError('That file is empty or not a backup.');
  }

  const file = parsed as Partial<BackupFile>;

  if (file.format !== BACKUP_FORMAT) {
    throw new BackupParseError(
      'That file is not a Clemnotes backup (it has no "clemnotes-backup" marker).'
    );
  }

  if (typeof file.formatVersion !== 'number' || file.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupParseError(
      `That backup is in format version ${String(file.formatVersion)}, which this build doesn't ` +
        `understand — it can read up to version ${BACKUP_FORMAT_VERSION}. Update Clemnotes and try again.`
    );
  }

  if (!file.data || typeof file.data !== 'object') {
    throw new BackupParseError('That backup has no data in it.');
  }

  const data = file.data as Partial<BackupTables>;
  const clean: BackupTables = { nodes: [], cards: [], reviews: [], dictionary: [], folders: [] };

  for (const table of BACKUP_TABLES) {
    const rows = data[table];
    // A missing table is fine — a backup taken before that table existed
    // simply has nothing to restore for it.
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) {
      throw new BackupParseError(`The "${table}" section of that backup isn't a list of rows.`);
    }
    for (const row of rows as UnknownRow[]) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string') {
        throw new BackupParseError(`A row in "${table}" has no id — the file looks corrupted.`);
      }
      if (typeof row.updatedAt !== 'number') {
        throw new BackupParseError(
          `A row in "${table}" has no updatedAt timestamp, so it can't be merged safely.`
        );
      }
      if (row.deletedAt !== null && typeof row.deletedAt !== 'number') {
        throw new BackupParseError(`A row in "${table}" has a malformed deletedAt value.`);
      }
    }
    // Types are checked structurally above; the row shape beyond those three
    // fields is whatever the exporting build wrote, and is copied through.
    (clean[table] as unknown[]) = rows as unknown[];
  }

  return {
    format: BACKUP_FORMAT,
    formatVersion: file.formatVersion,
    schemaVersion: typeof file.schemaVersion === 'number' ? file.schemaVersion : 0,
    exportedAt: typeof file.exportedAt === 'number' ? file.exportedAt : 0,
    counts: {
      nodes: clean.nodes.length,
      cards: clean.cards.length,
      reviews: clean.reviews.length,
      dictionary: clean.dictionary.length,
      folders: clean.folders.length,
    },
    data: clean,
  };
}

/**
 * True when the backup came from a newer database schema than this build runs.
 * Not fatal — rows carry their own fields — but worth telling the user, since
 * anything the newer schema added will sit unused until they update.
 */
export function isFromNewerSchema(file: BackupFile): boolean {
  return file.schemaVersion > CURRENT_SCHEMA_VERSION;
}

interface Timestamped {
  id: string;
  updatedAt: number;
}

/**
 * Merge one table.
 *
 * The rule is the same last-write-wins comparison cloud sync uses, and that is
 * not a coincidence: if importing a backup resolved conflicts differently from
 * syncing one, restoring on a synced device would produce a state neither
 * device agreed on, and the next sync would fight it. Same rule, same result.
 */
function mergeRows<T extends Timestamped>(incoming: T[], existing: T[]): {
  writes: T[];
  result: Omit<TableImportResult, 'table'>;
} {
  const existingById = new Map(existing.map((row) => [row.id, row]));
  const writes: T[] = [];
  let added = 0;
  let updated = 0;
  let kept = 0;

  for (const row of incoming) {
    const mine = existingById.get(row.id);
    if (!mine) {
      writes.push(row);
      added += 1;
    } else if (row.updatedAt > mine.updatedAt) {
      writes.push(row);
      updated += 1;
    } else {
      kept += 1;
    }
  }

  return { writes, result: { added, updated, kept } };
}

/**
 * Write a backup into the database.
 *
 * `merge` keeps whichever version of a row is newer, so importing a backup on
 * a device that has moved on since won't roll it back. `replace` empties the
 * tables first — the "restore this exact state" case, and the destructive one,
 * so the caller is responsible for making the user say yes to it.
 *
 * The whole import runs in one transaction. A restore that half-succeeded
 * would leave cards pointing at rems that never arrived, which is a worse
 * position than the one the user was trying to recover from.
 */
export async function importBackup(file: BackupFile, mode: ImportMode): Promise<ImportReport> {
  const tables = [db.nodes, db.cards, db.reviews, db.dictionary, db.folders];
  const results: TableImportResult[] = [];

  await db.transaction('rw', tables, async () => {
    if (mode === 'replace') {
      await Promise.all(tables.map((t) => t.clear()));
    }

    for (const name of BACKUP_TABLES) {
      const incoming = file.data[name] as unknown as Timestamped[];
      if (incoming.length === 0) {
        results.push({ table: name, added: 0, updated: 0, kept: 0 });
        continue;
      }

      const table = db[name] as unknown as {
        toArray: () => Promise<Timestamped[]>;
        bulkPut: (rows: Timestamped[]) => Promise<unknown>;
      };
      const existing = mode === 'replace' ? [] : await table.toArray();
      const { writes, result } = mergeRows(incoming, existing);
      if (writes.length > 0) await table.bulkPut(writes);
      results.push({ table: name, ...result });
    }
  });

  // Every table may have been rewritten; the search index is a cache of
  // `plainText` and cannot be patched row by row from here.
  invalidateSearchIndex();

  return {
    mode,
    tables: results,
    added: results.reduce((n, r) => n + r.added, 0),
    updated: results.reduce((n, r) => n + r.updated, 0),
    kept: results.reduce((n, r) => n + r.kept, 0),
  };
}
