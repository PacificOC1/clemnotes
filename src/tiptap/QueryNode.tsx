import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import type { NodeViewProps } from '@tiptap/react';
import {
  DEFAULT_LIMIT,
  describeQuery,
  isEmptyQuery,
  parseQuery,
  runQuery,
  serializeQuery,
  type RemQuery,
} from '../db/query';
import { findRootPage } from '../db/repository';
import { useNavigation } from '../context/NavigationContext';
import { useRemId } from '../context/RemContext';

/**
 * A live list of every rem matching a filter, embedded in a rem.
 *
 * A portal shows one rem you picked. This shows every rem that answers a
 * question, and keeps answering it as the notebook changes — which is what
 * turns an outliner from somewhere notes are kept into something you can ask.
 *
 * The filter is stored on the node as JSON, so it travels with the rem through
 * sync, export and backup like any other content. The results are not stored
 * at all: they are a `useLiveQuery`, so they are never a stale copy of an
 * answer.
 */
function QueryView({ node, updateAttributes, editor }: NodeViewProps) {
  const query = parseQuery(node.attrs.query);
  const { onZoomTo } = useNavigation();
  const remId = useRemId();
  const [open, setOpen] = useState(() => isEmptyQuery(query));

  const results = useLiveQuery(() => runQuery(query), [node.attrs.query]) ?? [];
  const homePage = useLiveQuery(
    () => (query.inPage ? findRootPage(query.inPage) : Promise.resolve(undefined)),
    [query.inPage]
  );
  /** The document this block is sitting in — what "this document" means. */
  const ownPage = useLiveQuery(
    () => (remId ? findRootPage(remId) : Promise.resolve(undefined)),
    [remId]
  );

  function set(patch: Partial<RemQuery>) {
    updateAttributes({ query: serializeQuery({ ...query, ...patch }) });
  }

  return (
    <NodeViewWrapper className="query-block" contentEditable={false}>
      <div className="query-head">
        <span className="query-title">{describeQuery(query, homePage?.plainText.trim())}</span>
        <span className="query-count">
          {isEmptyQuery(query) ? '' : `${results.length}${results.length === DEFAULT_LIMIT ? '+' : ''}`}
        </span>
        {editor.isEditable && (
          <button type="button" className="query-edit" onClick={() => setOpen((v) => !v)}>
            {open ? 'Done' : 'Edit'}
          </button>
        )}
      </div>

      {open && editor.isEditable && (
        <div className="query-filters">
          <label>
            <span>Text</span>
            <input
              type="text"
              value={query.text ?? ''}
              placeholder="any word"
              onChange={(e) => set({ text: e.target.value })}
            />
          </label>
          <label>
            <span>Edited in the last</span>
            <input
              type="number"
              min={0}
              value={query.editedWithinDays ?? ''}
              placeholder="any time"
              onChange={(e) => set({ editedWithinDays: Number(e.target.value) || undefined })}
            />
            <span className="query-unit">days</span>
          </label>
          <label className="query-check">
            <input
              type="checkbox"
              checked={Boolean(query.hasCards)}
              onChange={(e) => set({ hasCards: e.target.checked || undefined })}
            />
            <span>Only rems with flashcards</span>
          </label>
          <label className="query-check">
            <input
              type="checkbox"
              checked={Boolean(query.inPage)}
              onChange={(e) => set({ inPage: e.target.checked ? ownPage?.id : undefined })}
              disabled={!ownPage}
            />
            <span>Only this document</span>
          </label>
        </div>
      )}

      {isEmptyQuery(query) ? (
        <p className="query-empty">Set a filter and this list fills itself in.</p>
      ) : results.length === 0 ? (
        <p className="query-empty">Nothing matches yet.</p>
      ) : (
        <ul className="query-results">
          {results.map((result) => (
            <li key={result.node.id}>
              <button type="button" onClick={() => onZoomTo(result.node.id)}>
                <span className="query-result-text">{result.node.plainText.trim() || 'Untitled'}</span>
                {result.node.isCard && <span className="query-result-card" title="Has flashcards">🂠</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </NodeViewWrapper>
  );
}

export const RemQueryBlock = Node.create({
  name: 'remQuery',
  group: 'block',
  atom: true,
  // No editable content of its own: everything about it is the filter.
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      query: { default: '{}' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-rem-query]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-rem-query': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(QueryView);
  },
});
