import { useState } from 'react';

/**
 * What you can do with a selection, shown only while there is one.
 *
 * A floating bar rather than a context menu: the operations are the ones the
 * keyboard already does to a single rem, and having them visible is most of
 * what makes multi-select discoverable at all.
 */

interface SelectionBarProps {
  count: number;
  onIndent: () => void | Promise<void>;
  onOutdent: () => void | Promise<void>;
  onCopy: () => Promise<boolean>;
  onDelete: () => void | Promise<void>;
  onClear: () => void;
}

export function SelectionBar({ count, onIndent, onOutdent, onCopy, onDelete, onClear }: SelectionBarProps) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  if (count === 0) return null;

  async function handleCopy() {
    const ok = await onCopy();
    setCopied(ok ? 'done' : 'failed');
    setTimeout(() => setCopied('idle'), 2000);
  }

  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected rems">
      <span className="selection-count">
        {count} rem{count === 1 ? '' : 's'} selected
      </span>
      <button type="button" onClick={() => void onOutdent()} title="Outdent (Shift+Tab)">⇤ Outdent</button>
      <button type="button" onClick={() => void onIndent()} title="Indent (Tab)">Indent ⇥</button>
      <button type="button" onClick={() => void handleCopy()}>
        {copied === 'done' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy as Markdown'}
      </button>
      <button type="button" className="selection-danger" onClick={() => void onDelete()}>Delete</button>
      <button type="button" className="selection-clear" onClick={onClear} title="Clear selection (Esc)">✕</button>
    </div>
  );
}
