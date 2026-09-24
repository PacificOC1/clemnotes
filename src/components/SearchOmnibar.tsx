import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { searchNodes, warmSearchIndex } from '../db/searchIndex';
import { runQuery } from '../db/query';
import { getNode } from '../db/repository';
import type { OutlinerNode } from '../db/schema';

interface Result {
  node: OutlinerNode;
  pageTitle: string | null;
}

export type SearchScope = 'all' | 'page';

interface SearchOmnibarProps {
  onClose: () => void;
  onSelect: (nodeId: string) => void;
  placeholder?: string;
  /**
   * Show scope and filter controls. Off for the embed pickers, where the
   * question is "which rem", not "what have I written about this".
   */
  filters?: boolean;
  /** The page on screen — what "This page" means. */
  pageId?: string | null;
  initialScope?: SearchScope;
  /** Picking a result while scoped to this page: show it in place rather than zooming. */
  onReveal?: (nodeId: string) => void;
}

/** Wrap each word of `term` found in `text` in a <mark>. */
function highlight(text: string, term: string): ReactNode {
  const words = term
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return text;
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'));
  return parts.map((part, i) =>
    i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>
  );
}

/**
 * ⌘K, and ⌘⇧F for find-in-page.
 *
 * Plain search goes through the live FlexSearch index, as before. Once a
 * scope or filter is on it becomes a query (`runQuery`) — the same engine the
 * `/query` block uses — so "this page", "has cards" and "edited this week"
 * mean exactly what they mean there, and work with or without any text.
 */
export function SearchOmnibar({
  onClose,
  onSelect,
  placeholder = 'Search your notes...',
  filters = false,
  pageId = null,
  initialScope = 'all',
  onReveal,
}: SearchOmnibarProps) {
  const [term, setTerm] = useState('');
  const [scope, setScope] = useState<SearchScope>(pageId ? initialScope : 'all');
  const [hasCards, setHasCards] = useState(false);
  const [recent, setRecent] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void warmSearchIndex();
    inputRef.current?.focus();
  }, []);

  const filtered = filters && (scope === 'page' || hasCards || recent);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next: Result[];
      if (filtered) {
        const found = await runQuery({
          text: term.trim() || undefined,
          hasCards: hasCards || undefined,
          editedWithinDays: recent ? 7 : undefined,
          inPage: scope === 'page' && pageId ? pageId : undefined,
          limit: 30,
        });
        const titles = new Map<string, string>();
        next = await Promise.all(
          found.map(async ({ node, pageId: page }) => {
            if (page && !titles.has(page)) titles.set(page, (await getNode(page))?.plainText.trim() || 'Untitled');
            return { node, pageTitle: page && page !== node.id ? titles.get(page)! : null };
          })
        );
      } else {
        next = (await searchNodes(term)).map(({ node, sourcePage }) => ({
          node,
          pageTitle: sourcePage && sourcePage.id !== node.id ? sourcePage.plainText || 'Untitled' : null,
        }));
      }
      if (!cancelled) {
        setResults(next);
        setActiveIndex(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [term, filtered, scope, hasCards, recent, pageId]);

  function choose(nodeId: string) {
    if (filters && scope === 'page' && onReveal) onReveal(nodeId);
    else onSelect(nodeId);
    onClose();
  }

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
    // Tab flips between everywhere and this page without leaving the keyboard.
    if (e.key === 'Tab' && filters && pageId) {
      e.preventDefault();
      setScope((s) => (s === 'all' ? 'page' : 'all'));
      return;
    }
    if (e.key === 'Enter' && results[activeIndex]) {
      e.preventDefault();
      choose(results[activeIndex].node.id);
    }
  }

  const nothingAsked = !term.trim() && !filtered;

  return (
    <div className="omnibar-overlay" onClick={onClose}>
      <div className="omnibar" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="omnibar-input"
          placeholder={filters && scope === 'page' ? 'Find in this page…' : placeholder}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {filters && (
          <div className="omnibar-filters">
            {pageId && (
              <div className="omnibar-scope" role="radiogroup" aria-label="Search scope">
                <button type="button" className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>
                  Everywhere
                </button>
                <button type="button" className={scope === 'page' ? 'active' : ''} onClick={() => setScope('page')}>
                  This page
                </button>
              </div>
            )}
            <button type="button" className={`omnibar-chip ${hasCards ? 'active' : ''}`} onClick={() => setHasCards((v) => !v)}>
              Has cards
            </button>
            <button type="button" className={`omnibar-chip ${recent ? 'active' : ''}`} onClick={() => setRecent((v) => !v)}>
              Edited this week
            </button>
            {pageId && <span className="omnibar-hint">Tab switches scope</span>}
          </div>
        )}
        {results.length > 0 && (
          <ul className="omnibar-results">
            {results.map((r, i) => (
              <li
                key={r.node.id}
                className={i === activeIndex ? 'active' : ''}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(r.node.id);
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                {r.pageTitle && <span className="omnibar-result-page">{r.pageTitle} · </span>}
                <span className="omnibar-result-content">{highlight(r.node.plainText, term)}</span>
                {r.node.isCard && <span className="omnibar-result-card">🂠</span>}
              </li>
            ))}
          </ul>
        )}
        {!nothingAsked && results.length === 0 && (
          <div className="omnibar-empty">{term.trim() ? `No results for "${term}"` : 'Nothing matches those filters'}</div>
        )}
      </div>
    </div>
  );
}
