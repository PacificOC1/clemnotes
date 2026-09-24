import { useEffect, useRef, useState } from 'react';
import { tableOfContents, type TocEntry } from '../db/outline';

interface Props {
  rootId: string;
  onPick: (id: string) => void;
  onClose: () => void;
}

/**
 * The headings on this page, as a jump list (#45). Read when opened rather
 * than kept live — it is a way to move around, not something to watch.
 */
export function TableOfContents({ rootId, onPick, onClose }: Props) {
  const [entries, setEntries] = useState<TocEntry[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void tableOfContents(rootId).then((found) => {
      if (!cancelled) setEntries(found);
    });
    return () => {
      cancelled = true;
    };
  }, [rootId]);

  useEffect(() => {
    function away(event: MouseEvent) {
      if (ref.current && !ref.current.parentElement?.contains(event.target as Node)) onClose();
    }
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const minLevel = entries && entries.length > 0 ? Math.min(...entries.map((e) => e.level)) : 1;

  return (
    <div className="toc" ref={ref} role="menu">
      <div className="toc-title">Contents</div>
      {entries === null ? null : entries.length === 0 ? (
        <p className="toc-empty">
          No headings on this page yet. Start a rem with <code>/h1</code>, <code>/h2</code> or{' '}
          <code>/h3</code> and it shows up here.
        </p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.id} style={{ paddingLeft: `${(entry.level - minLevel) * 14}px` }}>
              <button type="button" role="menuitem" className={`toc-level-${entry.level}`} onClick={() => onPick(entry.id)}>
                {entry.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
