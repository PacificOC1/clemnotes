import { useState, useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import {
  getChildren,
  getNode,
  createSiblingAfter,
  createFirstChild,
  createPortalChild,
  updateContent,
  toggleCollapsed,
  indentNode,
  outdentNode,
  mergeWithPreviousSibling,
  deleteNode,
} from '../db/repository';
import { WikiLink } from '../tiptap/WikiLinkNode';
import { Math } from '../tiptap/MathNode';
import { parseDoc, docToPlainText, isDocEmpty, EMPTY_DOC, type DocNode } from '../tiptap/docUtils';
import { SearchOmnibar } from './SearchOmnibar';

interface OutlinerNodeProps {
  nodeId: string;
  depth: number;
  onFocusRequest: (nodeId: string) => void;
  focusedNodeId: string | null;
  onZoomTo: (pageId: string) => void;
}

export function OutlinerNode({ nodeId, depth, onFocusRequest, focusedNodeId, onZoomTo }: OutlinerNodeProps) {
  const node = useLiveQuery(() => getNode(nodeId), [nodeId]);
  const children = useLiveQuery(() => getChildren(nodeId), [nodeId, node?.childrenIds.join(',')]) ?? [];
  const portalTarget = useLiveQuery(
    () => (node?.isPortal && node.portalTargetId ? getNode(node.portalTargetId) : Promise.resolve(undefined)),
    [node?.isPortal, node?.portalTargetId]
  );

  const [showEmbedPicker, setShowEmbedPicker] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasHydrated = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        blockquote: false,
        horizontalRule: false,
      }),
      Placeholder.configure({ placeholder: 'Type something... [[link]] or $math$' }),
      WikiLink,
      Math,
    ],
    content: EMPTY_DOC,
    onFocus: () => onFocusRequest(nodeId),
    onUpdate: ({ editor }) => {
      const json = editor.getJSON() as DocNode;
      const docJson = JSON.stringify(json);
      const plainText = docToPlainText(json);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        updateContent(nodeId, docJson, plainText);
      }, 300);
    },
    editorProps: {
      attributes: { class: 'outliner-editor-content' },
      handleKeyDown: (view, event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          createSiblingAfter(nodeId).then((n) => onFocusRequest(n.id));
          return true;
        }
        if (event.key === 'Tab') {
          event.preventDefault();
          const action = event.shiftKey ? outdentNode(nodeId) : indentNode(nodeId);
          action.then(() => onFocusRequest(nodeId));
          return true;
        }
        if (event.key === 'Backspace') {
          const { selection } = view.state;
          const atStart = selection.empty && selection.from <= 1;
          const empty = isDocEmpty(view.state.doc.toJSON() as DocNode);
          if (atStart && empty) {
            event.preventDefault();
            mergeWithPreviousSibling(nodeId).then((targetId) => {
              if (targetId) onFocusRequest(targetId);
            });
            return true;
          }
        }
        return false;
      },
    },
  }, []);

  // Hydrate the editor with this node's real content once it loads, and
  // keep it in sync with external changes (e.g. after a merge) — but only
  // when the editor doesn't currently have focus, so we don't fight the
  // user's live typing.
  useEffect(() => {
    if (!editor || !node) return;
    if (editor.isFocused) return;
    const incoming = parseDoc(node.content);
    const incomingStr = JSON.stringify(incoming);
    const currentStr = JSON.stringify(editor.getJSON());
    if (!hasHydrated.current || incomingStr !== currentStr) {
      editor.commands.setContent(incoming, { emitUpdate: false });
      hasHydrated.current = true;
    }
  }, [editor, node?.content]);

  useEffect(() => {
    if (focusedNodeId === nodeId && editor) {
      editor.commands.focus('end');
    }
  }, [focusedNodeId, nodeId, editor]);

  if (!node) return null;

  async function handleAddChild() {
    const child = await createFirstChild(nodeId);
    onFocusRequest(child.id);
  }

  async function handleEmbedSelect(targetId: string) {
    await createPortalChild(nodeId, targetId);
  }

  // Portal nodes render a live, editable embed of another node's subtree
  // instead of their own text — the embedded OutlinerNode is the exact
  // same component/subtree bound to the target id, so edits made inside
  // the portal write straight back to the real node.
  if (node.isPortal && node.portalTargetId) {
    return (
      <div className="outliner-node" style={{ marginLeft: depth === 0 ? 0 : 20 }}>
        <div className="portal-embed">
          <div className="portal-header">
            <span className="portal-header-label" onClick={() => onZoomTo(node.portalTargetId!)}>
              ↗ {portalTarget?.plainText || 'Untitled'}
            </span>
            <button className="portal-remove-btn" onClick={() => deleteNode(nodeId)} title="Remove embed">
              ×
            </button>
          </div>
          <div className="portal-body">
            <OutlinerNode
              nodeId={node.portalTargetId}
              depth={0}
              onFocusRequest={onFocusRequest}
              focusedNodeId={focusedNodeId}
              onZoomTo={onZoomTo}
            />
          </div>
        </div>
      </div>
    );
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

        <div className="outliner-input-wrapper">
          <EditorContent editor={editor} />
        </div>

        <button className="embed-btn" onClick={() => setShowEmbedPicker(true)} title="Embed a page or bullet (portal)">
          ⧉
        </button>
        <button className="zoom-in-btn" onClick={() => onZoomTo(nodeId)} title="Zoom into this bullet">
          ⤢
        </button>
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
            onZoomTo={onZoomTo}
          />
        ))}

      {showEmbedPicker && (
        <SearchOmnibar
          onClose={() => setShowEmbedPicker(false)}
          onSelect={handleEmbedSelect}
          placeholder="Embed a page or bullet..."
        />
      )}
    </div>
  );
}
