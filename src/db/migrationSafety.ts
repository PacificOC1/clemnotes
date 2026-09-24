import Dexie from 'dexie';
import { v4 as uuid } from 'uuid';

/**
 * A copy of the notebook taken before every schema upgrade.
 *
 * Dexie runs an upgrade inside the same `versionchange` transaction that opens
 * the database, rewriting rows in place. Two of the eleven upgrades so far (the
 * v10 link backfill and the v11 cloze repair) rewrite stored documents, and a
 * bug in the next one would corrupt local data with nothing to go back to — so
 * before the real database is opened, this looks at the version already on
 * disk and, if an upgrade is about to run, copies every table somewhere else
 * first.
 *
 * Three decisions worth knowing about:
 *
 * - **The copy is taken outside the upgrade**, from a second, schema-less Dexie
 *   handle opened at whatever version is installed. It cannot be taken inside
 *   an upgrade function: awaiting anything that is not part of the
 *   `versionchange` transaction lets IndexedDB commit it early, and the upgrade
 *   would continue in a transaction that no longer exists.
 * - **Snapshots live in their own database**, not in a table of the one being
 *   upgraded. A table there would need a schema version of its own to exist,
 *   which is exactly the thing being changed, and would be wiped by anyone who
 *   clears "the notebook" to start again.
 * - **The last three are kept.** Enough to survive an upgrade that went wrong
 *   and was then followed by another before anyone noticed; few enough that a
 *   large notebook does not quietly triple its disk use.
 */

export const SNAPSHOT_DB_NAME = 'clemnotes-migration-snapshots';
export const MAIN_DB_NAME = 'outliner-app-db';
export const SNAPSHOTS_KEPT = 3;

export interface MigrationSnapshot {
  id: string;
  takenAt: number;
  /** The schema version the rows were written under. */
  fromVersion: number;
  /** The version the app was about to upgrade to. */
  toVersion: number;
  /** Every table, exactly as stored — images included, as Blobs. */
  tables: Record<string, unknown[]>;
  counts: Record<string, number>;
}

/** A snapshot without its rows — what a list of them needs. */
export type SnapshotSummary = Omit<MigrationSnapshot, 'tables'>;

class SnapshotDB extends Dexie {
  snapshots!: Dexie.Table<MigrationSnapshot, string>;

  constructor() {
    super(SNAPSHOT_DB_NAME);
    this.version(1).stores({ snapshots: 'id, takenAt' });
  }
}

let snapshotDb: SnapshotDB | null = null;
function snapshots(): SnapshotDB {
  snapshotDb ??= new SnapshotDB();
  return snapshotDb;
}

/** Everything in a database, read through a handle with no schema of its own. */
async function readEverything(probe: Dexie): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of probe.tables) {
    out[table.name] = await table.toArray();
  }
  return out;
}

export type PrepareOutcome =
  | { status: 'fresh' }
  | { status: 'current'; version: number }
  | { status: 'snapshotted'; snapshot: SnapshotSummary }
  | {
      status: 'snapshot-failed';
      fromVersion: number;
      toVersion: number;
      error: string;
      /** The rows the snapshot would have held, so they can be saved by hand. */
      tables: Record<string, unknown[]>;
    };

/**
 * Snapshot the notebook if opening it at `targetVersion` is about to run an
 * upgrade.
 *
 * Must be awaited before anything touches the real database — the first query
 * against it opens it, and opening it is the upgrade.
 *
 * A failure to *write* the snapshot (a full disk, say) is reported rather than
 * swallowed, with the rows attached: the caller should not go on to upgrade
 * without either a snapshot or the person's say-so, because proceeding
 * silently is exactly the situation this exists to prevent. A failure to even
 * *read* the old database is not this module's to judge — the real open will
 * hit the same thing and report it properly — so that proceeds as "fresh".
 */
export async function snapshotBeforeUpgrade(
  targetVersion: number,
  dbName = MAIN_DB_NAME,
  now = Date.now()
): Promise<PrepareOutcome> {
  let fromVersion: number;
  let tables: Record<string, unknown[]>;

  try {
    if (!(await Dexie.exists(dbName))) return { status: 'fresh' };
    const probe = new Dexie(dbName);
    try {
      await probe.open();
      fromVersion = probe.verno;
      if (fromVersion >= targetVersion) return { status: 'current', version: fromVersion };
      tables = await readEverything(probe);
    } finally {
      probe.close();
    }
  } catch (err) {
    console.warn('[clemnotes] could not read the database before upgrading it', err);
    return { status: 'fresh' };
  }

  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(tables)) counts[name] = rows.length;

  const snapshot: MigrationSnapshot = {
    id: uuid(),
    takenAt: now,
    fromVersion,
    toVersion: targetVersion,
    tables,
    counts,
  };

  try {
    const store = snapshots();
    await store.transaction('rw', store.snapshots, async () => {
      await store.snapshots.add(snapshot);
      await pruneSnapshots(store);
    });
  } catch (err) {
    return {
      status: 'snapshot-failed',
      fromVersion,
      toVersion: targetVersion,
      error: err instanceof Error ? err.message : String(err),
      tables,
    };
  }

  const { tables: _rows, ...summary } = snapshot;
  return { status: 'snapshotted', snapshot: summary };
}

async function pruneSnapshots(store: SnapshotDB): Promise<void> {
  const ids = await store.snapshots.orderBy('takenAt').reverse().primaryKeys();
  const stale = ids.slice(SNAPSHOTS_KEPT);
  if (stale.length > 0) await store.snapshots.bulkDelete(stale);
}

/** Newest first, without the rows — cheap enough to list in the sidebar. */
export async function listSnapshots(): Promise<SnapshotSummary[]> {
  const all = await snapshots().snapshots.orderBy('takenAt').reverse().toArray();
  return all.map(({ tables: _rows, ...summary }) => summary);
}

export async function getSnapshot(id: string): Promise<MigrationSnapshot | undefined> {
  return snapshots().snapshots.get(id);
}

/** For tests: close the handle so the database can be deleted between runs. */
export function closeSnapshotDb(): void {
  snapshotDb?.close();
  snapshotDb = null;
}
