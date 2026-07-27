import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { buildEntriesMap, getAllDictionaryEntries } from '../db/dictionaryRepository';
import { notifyDictionaryUpdated, updateDictionaryStore } from '../db/dictionaryStore';
import type { DictionaryEntry } from '../db/schema';

interface DictionaryContextValue {
  entries: DictionaryEntry[];
  modalEntryId: string | null;
  dictionaryOpen: boolean;
  setDictionaryOpen: (open: boolean) => void;
  openEntryModal: (id: string) => void;
  closeEntryModal: () => void;
}

const DictionaryContext = createContext<DictionaryContextValue>({
  entries: [],
  modalEntryId: null,
  dictionaryOpen: false,
  setDictionaryOpen: () => {},
  openEntryModal: () => {},
  closeEntryModal: () => {},
});

export function DictionaryProvider({ children }: { children: ReactNode }) {
  const entries = useLiveQuery(() => getAllDictionaryEntries(), []) ?? [];
  const [modalEntryId, setModalEntryId] = useState<string | null>(null);
  const [dictionaryOpen, setDictionaryOpen] = useState(false);

  const entriesMap = useMemo(() => buildEntriesMap(entries), [entries]);

  useEffect(() => {
    updateDictionaryStore(entriesMap, (id) => setModalEntryId(id));
    notifyDictionaryUpdated();
  }, [entriesMap]);

  const value = useMemo(
    () => ({
      entries,
      modalEntryId,
      dictionaryOpen,
      setDictionaryOpen,
      openEntryModal: setModalEntryId,
      closeEntryModal: () => setModalEntryId(null),
    }),
    [entries, modalEntryId, dictionaryOpen]
  );

  return <DictionaryContext.Provider value={value}>{children}</DictionaryContext.Provider>;
}

export function useDictionary() {
  return useContext(DictionaryContext);
}
