import { db } from './database';
import { invalidateSearchIndex } from './searchIndex';
import type { Flashcard, OutlinerNode } from './schema';

/**
 * Undo for everything above the text level.
 *
 * Tiptap's own history covers typing inside one rem. Delete a rem, indent the
 * wrong one, drag a subtree onto the wrong parent, and there was no way back:
 * the operation went straight to Dexie and that was that. With multi-select,
 * one mistake can now take a dozen rems with it.
 *
 * The mechanism is a snapshot rather than an inverse operation per mutation.
 * Recording "the inverse of an indent" means re-deriving where the rem came
 * from, and every new operation needs its own inverse written and kept correct.
 * Recording the rows as they were needs none of that: restoring them *is* the
 * inverse, for any operation, including ones not written yet. The cost is
 * holding a few rows in memory, which for a structural edit is a handful.
 */

/** A row as it was, or `null` when it did not exist yet. */
interface Before<T> {
  id: string;
  row: T | null;
}

export interface UndoEntry {
  label: string;
  at: number;
  nodes: Before<OutlinerNode>[];
  cards: Before<Flashcard>[];
}

/** Deep enough to cover a run of mistakes, shallow enough to stay cheap. */
const DEPTH = 40;

const stack: UndoEntry[] = [];
const listeners = new Set<() => void>();

/**
 * While an operation is being recorded, nested operations must not record
 * their own entries — a bulk delete of five rems is one thing you did, so it
 * has to be one thing you can undo.
 */
let recording = 0;

function announce(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to stack changes, so the UI can offer the undo while it exists. */
export function onUndoChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function peekUndo(): UndoEntry | null {
  return stack[stack.length - 1] ?? null;
}

export function undoDepth(): number {
  return stack.length;
}

export function clearUndoHistory(): void {
  stack.length = 0;
  announce();
}

/** Capture the rows an operation is about to touch. */
export async function takeSnapshot(
  label: string,
  nodeIds: Array<string | null | undefined>,
  cardIds: string[] = []
): Promise<UndoEntry> {
  const nodes = [...new Set(nodeIds.filter((id): id is string => Boolean(id)))];
  const cards = [...new Set(cardIds)];

  const [nodeRows, cardRows] = await Promise.all([
    db.nodes.bulkGet(nodes),
    cards.length > 0 ? db.cards.bulkGet(cards) : Promise.resolve([]),
  ]);

  return {
    label,
    at: Date.now(),
    nodes: nodes.map((id, i) => ({ id, row: nodeRows[i] ?? null })),
    cards: cards.map((id, i) => ({ id, row: cardRows[i] ?? null })),
  };
}

/**
 * Note a row the operation created, so undoing it puts the row back to "did
 * not exist". Called after the fact, because the id does not exist before.
 */
export function noteCreated(entry: UndoEntry, ids: Array<string | null | undefined>): void {
  for (const id of ids) {
    if (id && !entry.nodes.some((n) => n.id === id)) entry.nodes.push({ id, row: null });
  }
}

/**
 * Put an entry on the stack — unless we are inside a larger operation that is
 * already recording, in which case that one owns the undo.
 */
export function pushUndo(entry: UndoEntry): void {
  if (recording > 0) return;
  if (entry.nodes.length === 0 && entry.cards.length === 0) return;
  stack.push(entry);
  if (stack.length > DEPTH) stack.shift();
  announce();
}

/**
 * Run `fn` as one undoable unit: any operation it calls records nothing of its
 * own, so a merge (which deletes a rem) or a bulk delete (which deletes five)
 * leaves exactly one thing on the stack. The caller takes the snapshot before
 * and pushes it after, so it can note anything created along the way.
 */
export async function asOneUndo<T>(fn: () => Promise<T>): Promise<T> {
  recording += 1;
  try {
    return await fn();
  } finally {
    recording -= 1;
  }
}

/**
 * Put the rows back as they were.
 *
 * A row that did not exist is *tombstoned* rather than removed. Undoing the
 * creation of a rem that has already synced and then hard-deleting it locally
 * would just pull it back down on the next poll; a tombstone is how this app
 * says "gone" in a way every device agrees with.
 */
export async function restore(entry: UndoEntry): Promise<void> {
  const now = Date.now();

  await db.transaction('rw', db.nodes, db.cards, async () => {
    const nodesToPut: OutlinerNode[] = [];
    const nodesToTombstone: OutlinerNode[] = [];

    for (const { id, row } of entry.nodes) {
      if (row) {
        nodesToPut.push({ ...row, updatedAt: now });
      } else {
        const current = await db.nodes.get(id);
        if (current && current.deletedAt === null) {
          nodesToTombstone.push({ ...current, deletedAt: now, updatedAt: now });
        }
      }
    }

    if (nodesToPut.length > 0) await db.nodes.bulkPut(nodesToPut);
    if (nodesToTombstone.length > 0) await db.nodes.bulkPut(nodesToTombstone);

    const cardsToPut: Flashcard[] = [];
    for (const { id, row } of entry.cards) {
      if (row) cardsToPut.push({ ...row, updatedAt: now });
      else {
        const current = await db.cards.get(id);
        if (current && current.deletedAt === null) {
          cardsToPut.push({ ...current, deletedAt: now, updatedAt: now });
        }
      }
    }
    if (cardsToPut.length > 0) await db.cards.bulkPut(cardsToPut);
  });

  // An undo can bring back rems, retire rems, and change their text in one
  // step. Patching the search index row by row here would be guesswork;
  // dropping it costs one rebuild on the next search.
  invalidateSearchIndex();
}

/** Undo the most recent structural change. Returns its label, or null. */
export async function undoLast(): Promise<string | null> {
  const entry = stack.pop();
  if (!entry) return null;
  announce();
  // Restoring must not itself become undoable.
  recording += 1;
  try {
    await restore(entry);
  } finally {
    recording -= 1;
  }
  return entry.label;
}
