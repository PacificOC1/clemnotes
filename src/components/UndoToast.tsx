import { useEffect, useState } from 'react';
import { onUndoChange, peekUndo, undoLast } from '../db/undo';

/**
 * The offer to take it back.
 *
 * A keyboard shortcut alone is not enough here: ⌘Z inside a focused editor
 * belongs to Tiptap, and the moment you most need structural undo — you have
 * just deleted something — is the moment you are least sure which one you will
 * get. A visible button removes the doubt.
 *
 * It shows for a few seconds after any structural change and then gets out of
 * the way. The entry stays on the stack either way; only the offer expires.
 */

const VISIBLE_MS = 7000;

export function UndoToast() {
  const [entry, setEntry] = useState(() => peekUndo());
  const [showing, setShowing] = useState(false);

  useEffect(() => {
    return onUndoChange(() => {
      const top = peekUndo();
      setEntry(top);
      setShowing(top !== null);
    });
  }, []);

  useEffect(() => {
    if (!showing) return;
    const timer = setTimeout(() => setShowing(false), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [showing, entry?.at]);

  if (!showing || !entry) return null;

  return (
    <div className="undo-toast" role="status">
      <span>{entry.label}</span>
      <button
        type="button"
        onClick={() => {
          void undoLast();
          setShowing(false);
        }}
      >
        Undo
      </button>
    </div>
  );
}
