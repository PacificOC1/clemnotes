import type { DictionaryEntry } from './schema';

let entriesMap = new Map<string, DictionaryEntry>();
let onEntryClick: (id: string) => void = () => {};

export function updateDictionaryStore(
  map: Map<string, DictionaryEntry>,
  onClick: (id: string) => void
): void {
  entriesMap = map;
  onEntryClick = onClick;
}

export function getDictionaryEntries(): Map<string, DictionaryEntry> {
  return entriesMap;
}

export function navigateToDictionaryEntry(id: string): void {
  onEntryClick(id);
}

export const DICTIONARY_UPDATED_EVENT = 'dictionary-updated';

export function notifyDictionaryUpdated(): void {
  window.dispatchEvent(new CustomEvent(DICTIONARY_UPDATED_EVENT));
}
