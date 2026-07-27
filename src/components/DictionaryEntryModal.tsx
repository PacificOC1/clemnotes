import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDictionaryEntry, updateDictionaryEntry, deleteDictionaryEntry } from '../db/dictionaryRepository';
import { useDictionary } from '../context/DictionaryContext';

export function DictionaryEntryModal() {
  const { modalEntryId, closeEntryModal } = useDictionary();
  const entry = useLiveQuery(
    () => (modalEntryId ? getDictionaryEntry(modalEntryId) : Promise.resolve(undefined)),
    [modalEntryId]
  );

  const [word, setWord] = useState('');
  const [definition, setDefinition] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (entry) {
      setWord(entry.displayWord);
      setDefinition(entry.definition);
      setEditing(false);
      setError(null);
    }
  }, [entry?.id, entry?.updatedAt]);

  if (!modalEntryId || !entry) return null;

  async function handleSave() {
    setError(null);
    try {
      await updateDictionaryEntry(entry!.id, { word, definition });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  }

  async function handleDelete() {
    await deleteDictionaryEntry(entry!.id);
    closeEntryModal();
  }

  return (
    <div className="dict-entry-overlay" onClick={closeEntryModal}>
      <div className="dict-entry-modal" onClick={(e) => e.stopPropagation()}>
        <button className="dict-entry-close" onClick={closeEntryModal} aria-label="Close">
          ×
        </button>

        {editing ? (
          <>
            <input
              className="dict-entry-word-input"
              value={word}
              onChange={(e) => setWord(e.target.value)}
              autoFocus
            />
            <textarea
              className="dict-entry-def-input"
              value={definition}
              onChange={(e) => setDefinition(e.target.value)}
              rows={5}
            />
            {error && <div className="dictionary-error">{error}</div>}
            <div className="dict-entry-actions">
              <button className="dictionary-cancel-btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="dictionary-save-btn" onClick={handleSave}>
                Save
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="dict-entry-word">{entry.displayWord}</h2>
            <p className="dict-entry-definition">{entry.definition}</p>
            <div className="dict-entry-actions">
              <button className="dictionary-delete-action" onClick={handleDelete}>
                Delete
              </button>
              <button className="dictionary-save-btn" onClick={() => setEditing(true)}>
                Edit
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
