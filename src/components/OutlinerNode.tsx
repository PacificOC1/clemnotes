import { useRef, useState, useEffect, type KeyboardEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  getChildren,
  getNode,
  createSiblingAfter,
  createFirstChild,
  updateContent,
  toggleCollapsed,
  indentNode,
  outdentNode,
  mergeWithPreviousSibling,
} from '../db/repository';

interface OutlinerNodeProps {
  nodeId: string;
  depth: number;
  /** Called with the id of a newly created/focused node so the parent can focus it. */
  onFocusRequest: (nodeId: string) => void;
  focusedNodeId: string | null;
}

export function OutlinerNode({ nodeId, depth, onFocusRequest, focusedNodeId }: OutlinerNodeProps) {
  const node = useLiveQuery(() => getNode(nodeId), [nodeId]);
  const children = useLiveQuery(() => getChildren(nodeId), [nodeId, node?.childrenIds.join(',')]) ?? [];

  const [draft, setDraft] = useState(node?.content ?? '');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local draft in sync when the underlying node changes externally
  // (e.g. after a merge), but don't fight the user's live typing.
  useEffect(() => {
    if (node && node.content !== draft && document.activeElement !== inputRef.current) {
      setDraft(node.content);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.content]);

  useEffect(() => {
    if (focusedNodeId === nodeId && inputRef.current) {
      inputRef.current.focus();
      const len = inputRef.current.value.length;
      inputRef.current.setSelectionRange(len, len);
    }
  }, [focusedNodeId, nodeId]);

  if (!node) return null;

  function handleChange(value: string) {
    setDraft(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      updateContent(nodeId, value);
    }, 300);
  }

  async function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const el = inputRef.current;
    const atStart = el?.selectionStart === 0 && el?.selectionEnd === 0;

    if (e.key === 'Enter') {
      e.preventDefault();
      const newNode = await createSiblingAfter(nodeId);
      onFocusRequest(newNode.id);
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        await outdentNode(nodeId);
      } else {
        await indentNode(nodeId);
      }
      onFocusRequest(nodeId);
      return;
    }

    if (e.key === 'Backspace' && atStart && draft === '') {
      e.preventDefault();
      const targetId = await mergeWithPreviousSibling(nodeId);
      if (targetId) onFocusRequest(targetId);
      return;
    }

    if (e.key === 'Tab' && e.altKey) {
      // reserved for future: alt+tab style navigation
    }
  }

  async function handleAddChild() {
    const child = await createFirstChild(nodeId);
    onFocusRequest(child.id);
  }

  return (
    <div className="outliner-node" style={{ marginLeft: depth === 0 ? 0 : 20 }}>
      <div className="outliner-row">
        {node.childrenIds.length > 0 ? (
          <button
            className="collapse-toggle"
            onClick={() => toggleCollapsed(nodeId)}
            aria-label={node.collapsed ? 'Expand' : 'Collapse'}
          >
            {node.collapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span className="bullet">•</span>
        )}
        <textarea
          ref={inputRef}
          className="outliner-input"
          rows={1}
          value={draft}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => onFocusRequest(nodeId)}
          placeholder="Type something..."
        />
        <button className="add-child-btn" onClick={handleAddChild} title="Add child">
          +
        </button>
      </div>

      {!node.collapsed &&
        children.map((child) => (
          <OutlinerNode
            key={child.id}
            nodeId={child.id}
            depth={depth + 1}
            onFocusRequest={onFocusRequest}
            focusedNodeId={focusedNodeId}
          />
        ))}
    </div>
  );
}
