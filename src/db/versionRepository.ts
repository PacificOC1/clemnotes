import Dexie from 'dexie';
import { v4 as uuid } from 'uuid';
import { db } from './database';
import type { OutlinerNode, RemVersion, VersionReason } from './schema';

/**
 * Version history: past states of a rem's text.
 *
 * Undo covers the last few structural changes in this tab; this covers
 * *text*, across sessions — the paragraph you rewrote on Tuesday and wanted
 * back on Friday. It is also where #22's conflicts go: when the same rem was
 * edited on two devices between syncs, the side that loses the last-write-wins
 * comparison is kept here instead of vanishing.
 *
 * A version is the text *before* a change, kept at most once per
 * `EDIT_GAP_MS` of editing: a burst of typing makes one version, not one per
 * debounced keystroke. Each rem keeps its newest `MAX_PER_REM`.
 */

export const EDIT_GAP_MS = 10 * 60 * 1000;
export const MAX_PER_REM = 50;

/** This rem's versions, newest first. */
export async function getVersions(nodeId: string): Promise<RemVersion[]> {
  return db.versions
    .where('[nodeId+savedAt]')
    .between([nodeId, Dexie.minKey], [nodeId, Dexie.maxKey])
    .reverse()
    .toArray();
}

async function newestVersion(nodeId: string): Promise<RemVersion | undefined> {
  return db.versions
    .where('[nodeId+savedAt]')
    .between([nodeId, Dexie.minKey], [nodeId, Dexie.maxKey])
    .last();
}

async function prune(nodeId: string): Promise<void> {
  const keys = await db.versions
    .where('[nodeId+savedAt]')
    .between([nodeId, Dexie.minKey], [nodeId, Dexie.maxKey])
    .reverse()
    .primaryKeys();
  const stale = keys.slice(MAX_PER_REM);
  if (stale.length > 0) await db.versions.bulkDelete(stale);
}

export async function keepVersion(
  node: Pick<OutlinerNode, 'id' | 'content' | 'plainText'>,
  reason: VersionReason,
  extra: Partial<Pick<RemVersion, 'from' | 'seen'>> = {},
  now = Date.now()
): Promise<RemVersion | null> {
  if (reason === 'conflict') {
    // A sync that fails after this point is retried from the same cursor and
    // would find the same conflict again; one copy of the losing text is enough.
    const existing = await getVersions(node.id);
    if (existing.some((v) => v.content === node.content)) return null;
  }
  const version: RemVersion = {
    id: uuid(),
    nodeId: node.id,
    content: node.content,
    plainText: node.plainText,
    savedAt: now,
    reason,
    ...extra,
  };
  await db.versions.add(version);
  await prune(node.id);
  return version;
}

/**
 * Called from the content write path with the rem as it was *before* the
 * write. Keeps it when the text is really changing, there is something to
 * keep, and the last version is older than the edit gap (or its text differs
 * — a rem restored a minute ago and then edited still gets its restore point).
 */
export async function noteEdit(before: OutlinerNode, nextContent: string, now = Date.now()): Promise<boolean> {
  if (before.content === nextContent || !before.plainText.trim()) return false;
  const newest = await newestVersion(before.id);
  if (newest && now - newest.savedAt < EDIT_GAP_MS) return false;
  if (newest && newest.content === before.content) return false;
  await keepVersion(before, 'edit', {}, now);
  return true;
}

/** Conflict versions nobody has looked at yet, newest first — the sync panel shows these. */
export async function getUnseenConflicts(): Promise<RemVersion[]> {
  const rows = await db.versions.where('reason').equals('conflict').toArray();
  return rows.filter((v) => v.seen === false).sort((a, b) => b.savedAt - a.savedAt);
}

export async function markConflictsSeen(nodeId: string): Promise<void> {
  const rows = await getVersions(nodeId);
  const unseen = rows.filter((v) => v.reason === 'conflict' && v.seen === false);
  if (unseen.length > 0) await db.versions.bulkPut(unseen.map((v) => ({ ...v, seen: true })));
}
