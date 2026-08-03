import { useEffect, useRef, useState } from 'react';
import {
  createDictionaryEntry,
  deleteDictionaryEntry,
  getDictionaryEntry,
  updateDictionaryEntry,
} from '../db/dictionaryRepository';
import { useDictionary } from '../context/DictionaryContext';
import { useLiveQuery } from 'dexie-react-hooks';

export function DictionaryView() {
  const { entries, editingEntryId, setEditingEntryId } = useDictionary();
  const [word, setWord] = useState('');
  const [definition, setDefinition] = useState('');
  const [error, setError] = useState<string | null>(null);
  const wordInputRef = useRef<HTMLInputElement>(null);

  const editingId = editingEntryId;
  const editingEntry = useLiveQuery(
    () => (editingId ? getDictionaryEntry(editingId) : Promise.resolve(undefined)),
    [editingId]
  );

  useEffect(() => {
    if (editingEntry) {
      setWord(editingEntry.displayWord);
      setDefinition(editingEntry.definition);
    }
  }, [editingEntry?.id, editingEntry?.updatedAt]);

  useEffect(() => {
    if (!editingId) {
      wordInputRef.current?.focus();
    }
  }, [editingId]);

  function resetForm() {
    setWord('');
    setDefinition('');
    setEditingEntryId(null);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!word.trim() || !definition.trim()) {
      setError('Word and definition are required');
      return;
    }

    try {
      if (editingId) {
        await updateDictionaryEntry(editingId, { word, definition });
      } else {
        await createDictionaryEntry(word, definition);
      }
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save entry');
    }
  }

  async function handleDelete(id: string) {
    await deleteDictionaryEntry(id);
    if (editingId === id) resetForm();
  }

  function handleEdit(entryId: string) {
    setEditingEntryId(entryId);
    setError(null);
  }

  return (
    <div className="dictionary-view">
      <header className="dictionary-view-header">
        <h1 className="dictionary-view-title">Definitions</h1>
        <p className="dictionary-view-desc">
          Add words and definitions here. Matching text in your notes is highlighted — hover for the
          definition, click to replace the word with it.
        </p>
      </header>

      <form className="dictionary-view-form" onSubmit={handleSubmit}>
        <div className="dictionary-view-form-row">
          <input
            ref={wordInputRef}
            type="text"
            placeholder="Word"
            value={word}
            onChange={(e) => setWord(e.target.value)}
          />
          <textarea
            placeholder="Definition"
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
            rows={3}
          />
        </div>
        <div className="dictionary-form-actions">
          {editingId && (
            <button type="button" className="dictionary-cancel-btn" onClick={resetForm}>
              Cancel
            </button>
          )}
          <button type="submit" className="dictionary-save-btn">
            {editingId ? 'Update entry' : 'Add word'}
          </button>
        </div>
        {error && <div className="dictionary-error">{error}</div>}
      </form>

      {entries.length > 0 ? (
        <ul className="dictionary-view-list">
          {entries.map((entry) => (
            <li key={entry.id} className={entry.id === editingId ? 'active' : ''}>
              <button type="button" className="dictionary-view-card" onClick={() => handleEdit(entry.id)}>
                <span className="dictionary-view-word">{entry.displayWord}</span>
                <span className="dictionary-view-def">{entry.definition}</span>
              </button>
              <button
                type="button"
                className="dictionary-delete-btn"
                onClick={() => handleDelete(entry.id)}
                aria-label={`Delete ${entry.displayWord}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="dictionary-view-empty">No words yet. Add your first entry above.</div>
      )}
    </div>
  );
}
