import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { buildEntriesMap, getAllDictionaryEntries } from '../db/dictionaryRepository';
import { notifyDictionaryUpdated, updateDictionaryStore } from '../db/dictionaryStore';
import type { DictionaryEntry } from '../db/schema';
import type { AppTab } from '../router/route';

export type { AppTab };

interface DictionaryContextValue {
  entries: DictionaryEntry[];
  modalEntryId: string | null;
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  editingEntryId: string | null;
  setEditingEntryId: (id: string | null) => void;
  openEntryModal: (id: string) => void;
  closeEntryModal: () => void;
}

const DictionaryContext = createContext<DictionaryContextValue>({
  entries: [],
  modalEntryId: null,
  activeTab: 'notes',
  setActiveTab: () => {},
  editingEntryId: null,
  setEditingEntryId: () => {},
  openEntryModal: () => {},
  closeEntryModal: () => {},
});

interface DictionaryProviderProps {
  children: ReactNode;
  /** The tab the URL says we are on — the route is the source of truth. */
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
}

export function DictionaryProvider({ children, activeTab, setActiveTab }: DictionaryProviderProps) {
  const entries = useLiveQuery(() => getAllDictionaryEntries(), []) ?? [];
  const [modalEntryId, setModalEntryId] = useState<string | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);

  const entriesMap = useMemo(() => buildEntriesMap(entries), [entries]);

  useEffect(() => {
    updateDictionaryStore(entriesMap, (id) => {
      setActiveTab('dictionary');
      setEditingEntryId(id);
    });
    notifyDictionaryUpdated();
  }, [entriesMap, setActiveTab]);

  const value = useMemo(
    () => ({
      entries,
      modalEntryId,
      activeTab,
      setActiveTab,
      editingEntryId,
      setEditingEntryId,
      openEntryModal: setModalEntryId,
      closeEntryModal: () => setModalEntryId(null),
    }),
    [entries, modalEntryId, activeTab, setActiveTab, editingEntryId]
  );

  return <DictionaryContext.Provider value={value}>{children}</DictionaryContext.Provider>;
}

export function useDictionary() {
  return useContext(DictionaryContext);
}
