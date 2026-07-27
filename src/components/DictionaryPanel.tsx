import { useEffect, useRef, useState } from 'react';
import {
  createDictionaryEntry,
  deleteDictionaryEntry,
  getDictionaryEntry,
  updateDictionaryEntry,
} from '../db/dictionaryRepository';
import { useDictionary } from '../context/DictionaryContext';
import { useLiveQuery } from 'dexie-react-hooks';

export function DictionaryPanel() {
  const { entries, dictionaryOpen, setDictionaryOpen } = useDictionary();
  const [word, setWord] = useState('');
  const [definition, setDefinition] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const wordInputRef = useRef<HTMLInputElement>(null);

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
    if (dictionaryOpen && !editingId) {
      wordInputRef.current?.focus();
    }
  }, [dictionaryOpen, editingId]);

  function resetForm() {
    setWord('');
    setDefinition('');
    setEditingId(null);
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
    setEditingId(entryId);
    setError(null);
  }

  if (!dictionaryOpen) {
    return (
      <button className="dictionary-trigger-btn" onClick={() => setDictionaryOpen(true)}>
        📖 Dictionary {entries.length > 0 && <span className="dictionary-count">{entries.length}</span>}
      </button>
    );
  }

  return (
    <div className="dictionary-panel">
      <div className="dictionary-panel-header">
        <span className="dictionary-panel-title">Dictionary</span>
        <button
          className="dictionary-close-btn"
          onClick={() => {
            setDictionaryOpen(false);
            resetForm();
          }}
          aria-label="Close dictionary"
        >
          ×
        </button>
      </div>

      <form className="dictionary-form" onSubmit={handleSubmit}>
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
        <div className="dictionary-form-actions">
          {editingId && (
            <button type="button" className="dictionary-cancel-btn" onClick={resetForm}>
              Cancel
            </button>
          )}
          <button type="submit" className="dictionary-save-btn">
            {editingId ? 'Update' : 'Add word'}
          </button>
        </div>
        {error && <div className="dictionary-error">{error}</div>}
      </form>

      {entries.length > 0 ? (
        <ul className="dictionary-list">
          {entries.map((entry) => (
            <li key={entry.id} className={entry.id === editingId ? 'active' : ''}>
              <button type="button" className="dictionary-list-item" onClick={() => handleEdit(entry.id)}>
                <span className="dictionary-list-word">{entry.displayWord}</span>
                <span className="dictionary-list-def">{entry.definition}</span>
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
        <div className="dictionary-empty">
          Add words here — matching text in your notes is highlighted. Hover for the definition, click to
          replace the word with it.
        </div>
      )}
    </div>
  );
}
