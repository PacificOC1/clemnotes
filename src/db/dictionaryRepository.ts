import { v4 as uuid } from 'uuid';
import { db } from './database';
import type { DictionaryEntry } from './schema';

export function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

export async function getAllDictionaryEntries(): Promise<DictionaryEntry[]> {
  const entries = await db.dictionary.orderBy('word').toArray();
  return entries.filter((e) => !e.deletedAt);
}

export async function getDictionaryEntry(id: string): Promise<DictionaryEntry | undefined> {
  const entry = await db.dictionary.get(id);
  return entry && !entry.deletedAt ? entry : undefined;
}

export async function lookupWord(word: string): Promise<DictionaryEntry | undefined> {
  const matches = await db.dictionary.where('word').equals(normalizeWord(word)).toArray();
  return matches.find((e) => !e.deletedAt);
}

export async function createDictionaryEntry(word: string, definition: string): Promise<DictionaryEntry> {
  const normalized = normalizeWord(word);
  const existing = await lookupWord(normalized);
  if (existing) {
    throw new Error(`"${word.trim()}" already exists in the dictionary`);
  }

  const now = Date.now();
  const entry: DictionaryEntry = {
    id: uuid(),
    word: normalized,
    displayWord: word.trim(),
    definition: definition.trim(),
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.dictionary.add(entry);
  return entry;
}

export async function updateDictionaryEntry(
  id: string,
  updates: { word?: string; definition?: string }
): Promise<DictionaryEntry> {
  const existing = await db.dictionary.get(id);
  if (!existing) throw new Error('Dictionary entry not found');

  const nextWord = updates.word !== undefined ? updates.word.trim() : existing.displayWord;
  const normalized = normalizeWord(nextWord);
  if (normalized !== existing.word) {
    const conflict = await lookupWord(normalized);
    if (conflict && conflict.id !== id) {
      throw new Error(`"${nextWord}" already exists in the dictionary`);
    }
  }

  const updated: DictionaryEntry = {
    ...existing,
    word: normalized,
    displayWord: nextWord,
    definition: updates.definition !== undefined ? updates.definition.trim() : existing.definition,
    updatedAt: Date.now(),
  };
  await db.dictionary.put(updated);
  return updated;
}

/**
 * Soft-delete, so the deletion syncs to your other devices instead of the row
 * simply going missing locally and being re-downloaded on the next merge.
 */
export async function deleteDictionaryEntry(id: string): Promise<void> {
  const now = Date.now();
  await db.dictionary.update(id, { deletedAt: now, updatedAt: now });
}

export function buildEntriesMap(entries: DictionaryEntry[]): Map<string, DictionaryEntry> {
  const map = new Map<string, DictionaryEntry>();
  for (const entry of entries) {
    map.set(entry.word, entry);
  }
  return map;
}
