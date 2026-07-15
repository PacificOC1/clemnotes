import { useEffect, useRef, useState } from 'react';
import { buildSearchIndex, type SearchResult } from '../db/searchIndex';

interface SearchOmnibarProps {
  onClose: () => void;
  onSelect: (nodeId: string) => void;
  placeholder?: string;
}

export function SearchOmnibar({ onClose, onSelect, placeholder = 'Search your notes...' }: SearchOmnibarProps) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef<((term: string) => Promise<SearchResult[]>) | null>(null);

  // Build the index once when the omnibar opens.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { query } = await buildSearchIndex();
      if (!cancelled) queryRef.current = query;
    })();
    inputRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!queryRef.current) return;
      const r = await queryRef.current(term);
      if (!cancelled) {
        setResults(r);
        setActiveIndex(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [term]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter' && results[activeIndex]) {
      e.preventDefault();
      onSelect(results[activeIndex].node.id);
      onClose();
    }
  }

  return (
    <div className="omnibar-overlay" onClick={onClose}>
      <div className="omnibar" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="omnibar-input"
          placeholder={placeholder}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {results.length > 0 && (
          <ul className="omnibar-results">
            {results.map((r, i) => (
              <li
                key={r.node.id}
                className={i === activeIndex ? 'active' : ''}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(r.node.id);
                  onClose();
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                {r.sourcePage && r.sourcePage.id !== r.node.id && (
                  <span className="omnibar-result-page">{r.sourcePage.plainText || 'Untitled'} · </span>
                )}
                <span className="omnibar-result-content">{r.node.plainText}</span>
              </li>
            ))}
          </ul>
        )}
        {term.trim() && results.length === 0 && (
          <div className="omnibar-empty">No results for "{term}"</div>
        )}
      </div>
    </div>
  );
}
