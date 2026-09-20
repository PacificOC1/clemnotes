import { useState, useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEditor, EditorContent } from '@tiptap/react';
import { useActiveEditor } from '../context/ActiveEditorContext';
import { handleMenuKey } from '../editor/menuStore';
import {
  getChildren,
  getNode,
  createSiblingAfter,
  createFirstChild,
  createPortalChild,
  updateContent,
  toggleCollapsed,
  ensureFirstChild,
  indentNode,
  outdentNode,
  mergeWithPreviousSibling,
  moveAmongSiblings,
  moveNodeRelativeTo,
  deleteNode,
  type DropPosition,
} from '../db/repository';
import { getCardsForNode, toggleCardDirection } from '../db/cardRepository';
import { copyLinkToRem } from '../db/clipboard';
import { useSelection } from '../context/SelectionContext';
import { RemContext } from '../context/RemContext';
import { rowExtensions } from '../tiptap/extensions';
import { parseDoc, docToPlainText, isDocEmpty, EMPTY_DOC, type DocNode } from '../tiptap/docUtils';
import { SearchOmnibar } from './SearchOmnibar';

/**
 * The id of the rem currently being dragged. Held in a module variable rather
 * than state because `dragover` can't read `dataTransfer` for security reasons
 * -- the browser only exposes the payload on `drop`, and we need to know what's
 * being dragged in order to draw the drop indicator.
 */
let draggingId: string | null = null;

/**
 * A private drag type rather than `text/plain`. ProseMirror (correctly) treats
 * a plain-text payload dropped onto an editor as text to insert, so carrying
 * the rem id that way meant dropping a rem onto another one pasted its UUID
 * into the target's content. Nothing but this app reads this type, so the
 * editor sees a drop it has no handler for and leaves the content alone.
 */
const REM_DRAG_TYPE = 'application/x-clemnotes-rem';

/**
 * Shared empty chain for the top of the tree, so the default prop value isn't
 * a fresh Set on every render of the root row.
 */
const NO_ANCESTORS: ReadonlySet<string> = new Set();

interface OutlinerNodeProps {
  nodeId: string;
  depth: number;
  onFocusRequest: (nodeId: string) => void;
  focusedNodeId: string | null;
  onZoomTo: (pageId: string) => void;
  isRoot?: boolean;
  /**
   * Every rem id rendered above this one, counting hops through portals.
   *
   * The parent tree can't contain a cycle — `moveNodeRelativeTo` refuses to
   * drop a rem into its own subtree — but portals are a second, unconstrained
   * graph laid over it: nothing stops a rem from embedding itself, an ancestor,
   * or a rem that embeds it back. Expanding one of those recurses forever, and
   * because each level resolves through an async live query it never overflows
   * the stack and throws; it just keeps mounting editors until the tab dies.
   * Carrying the chain down lets a portal notice it's about to re-enter
   * something it already sits inside and stop.
   */
  ancestorIds?: ReadonlySet<string>;
}

export function OutlinerNode({
  nodeId,
  depth,
  onFocusRequest,
  focusedNodeId,
  onZoomTo,
  isRoot,
  ancestorIds = NO_ANCESTORS,
}: OutlinerNodeProps) {
  const node = useLiveQuery(() => getNode(nodeId), [nodeId]);
  const children = useLiveQuery(() => getChildren(nodeId), [nodeId, node?.childrenIds.join(',')]) ?? [];
  const portalTarget = useLiveQuery(
    () => (node?.isPortal && node.portalTargetId ? getNode(node.portalTargetId) : Promise.resolve(undefined)),
    [node?.isPortal, node?.portalTargetId]
  );
  const cards = useLiveQuery(() => (node?.isCard ? getCardsForNode(nodeId) : Promise.resolve([])), [nodeId, node?.isCard]) ?? [];

  /** This row's ancestors plus itself — what the rows below it inherit. */
  const chain = useMemo(() => new Set(ancestorIds).add(nodeId), [ancestorIds, nodeId]);

  const [showEmbedPicker, setShowEmbedPicker] = useState(false);
  const [dropHint, setDropHint] = useState<DropPosition | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasHydrated = useRef(false);

  const { setActive } = useActiveEditor();
  const { selected, onSelectRow } = useSelection();
  const remContextValue = useMemo(() => ({ nodeId }), [nodeId]);

  const editor = useEditor({
    extensions: rowExtensions,
    content: EMPTY_DOC,
    onFocus: ({ editor }) => {
      onFocusRequest(nodeId);
      setActive(editor, nodeId);
    },
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
      attributes: { class: 'rem-editor' },
      // Belt and braces alongside the custom drag type: while a rem drag is in
      // flight, the editor never handles the drop itself.
      handleDrop: (_view, event) => {
        if (!draggingId) return false;
        event.preventDefault();
        return true;
      },
      handleKeyDown: (view, event) => {
        // The slash / [[ menus get first refusal on navigation keys.
        if (handleMenuKey(event)) {
          event.preventDefault();
          return true;
        }

        const { $from } = view.state.selection;
        let insideTable = false;
        for (let d = $from.depth; d > 0; d--) {
          const typeName = $from.node(d).type.name;
          if (typeName === 'tableCell' || typeName === 'tableHeader') {
            insideTable = true;
            break;
          }
        }

        // Alt+↑/↓ moves the whole rem among its siblings.
        if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault();
          void moveAmongSiblings(nodeId, event.key === 'ArrowUp' ? -1 : 1);
          return true;
        }

        if (event.key === 'Enter' && !event.shiftKey && !insideTable) {
          event.preventDefault();
          // The title row's "sibling" is another top-level page, so the usual
          // Enter behaviour turned every stray Return in a heading into a new
          // document. From the title, Enter drops into the body instead —
          // reusing the first bullet if there is one, creating it if not.
          if (isRoot) {
            void ensureFirstChild(nodeId).then((child) => {
              if (child) onFocusRequest(child.id);
            });
            return true;
          }
          createSiblingAfter(nodeId).then((n) => onFocusRequest(n.id));
          return true;
        }
        if (event.key === 'Tab' && !insideTable) {
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

  // Older pages did not have a first bullet until the user clicked +. Keep a
  // ready-to-type slot directly beneath every page title, including those.
  useEffect(() => {
    if (isRoot && node && node.childrenIds.length === 0) {
      void ensureFirstChild(nodeId);
    }
  }, [isRoot, nodeId, node?.childrenIds.length]);

  if (!node || node.deletedAt) return null;

  async function handleAddChild() {
    const child = await createFirstChild(nodeId);
    onFocusRequest(child.id);
  }

  async function handleEmbedSelect(targetId: string) {
    const created = await createPortalChild(nodeId, targetId);
    if (!created) {
      window.alert("A rem can't embed itself or anything it already sits inside.");
    }
  }

  function handleDragStart(event: React.DragEvent) {
    draggingId = nodeId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(REM_DRAG_TYPE, nodeId);
  }

  function handleDragOver(event: React.DragEvent) {
    if (!draggingId || draggingId === nodeId || isRoot) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    // Top and bottom edges reorder; the middle band nests the dragged rem
    // underneath this one, which is how you reparent without a second gesture.
    setDropHint(ratio < 0.3 ? 'before' : ratio > 0.7 ? 'after' : 'child');
  }

  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    const sourceId = draggingId || event.dataTransfer.getData(REM_DRAG_TYPE);
    const position = dropHint;
    setDropHint(null);
    draggingId = null;
    if (!sourceId || !position) return;
    await moveNodeRelativeTo(sourceId, nodeId, position);
  }

  const liveCards = cards.filter((c) => !c.suspended);
  const isClozeRem = liveCards.some((c) => c.kind === 'cloze');

  // Portal nodes render a live, editable embed of another node's subtree
  // instead of their own text — the embedded OutlinerNode is the exact
  // same component/subtree bound to the target id, so edits made inside
  // the portal write straight back to the real node.
  if (node.isPortal && node.portalTargetId) {
    // Re-entering something already open above us would loop forever, so show
    // a link to it instead of expanding it in place. `chain` includes this rem,
    // which also catches a portal pointed straight at itself.
    const isCircular = chain.has(node.portalTargetId);

    return (
      <div className="rem" data-depth={depth}>
        <div className="portal-embed">
          <div className="portal-header">
            <button type="button" className="portal-header-label" onClick={() => onZoomTo(node.portalTargetId!)}>
              ↗ {portalTarget?.plainText || 'Untitled'}
            </button>
            <button type="button" className="portal-remove-btn" onClick={() => deleteNode(nodeId)} title="Remove embed">
              ×
            </button>
          </div>
          <div className="portal-body">
            {isCircular ? (
              <p className="portal-circular">
                This embed points at a rem it already sits inside, so it can't be opened here.
                Use ↗ to jump to it.
              </p>
            ) : (
              <OutlinerNode
                nodeId={node.portalTargetId}
                depth={0}
                onFocusRequest={onFocusRequest}
                focusedNodeId={focusedNodeId}
                onZoomTo={onZoomTo}
                ancestorIds={chain}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  if (isRoot) {
    return (
      <div className="rem rem-root">
        <div className="page-title">
          <EditorContent editor={editor} />
        </div>
        <div className="rem-children rem-children-root">
          {children.map((child) => (
            <OutlinerNode
              key={child.id}
              nodeId={child.id}
              depth={0}
              onFocusRequest={onFocusRequest}
              focusedNodeId={focusedNodeId}
              onZoomTo={onZoomTo}
              ancestorIds={chain}
            />
          ))}
        </div>
        {showEmbedPicker && (
          <SearchOmnibar
            onClose={() => setShowEmbedPicker(false)}
            onSelect={handleEmbedSelect}
            placeholder="Embed a page or rem..."
          />
        )}
      </div>
    );
  }

  const hasChildren = children.length > 0;
  const isSelected = selected.has(nodeId);

  /**
   * A plain click on the bullet zooms, as it always did. With a modifier it
   * selects instead — Cmd/Ctrl toggles this row, Shift extends from the last
   * one clicked. Selection lives on the bullet rather than on the row so it
   * never competes with placing the cursor in the text.
   */
  function handleBulletClick(event: MouseEvent) {
    if (event.shiftKey) {
      event.preventDefault();
      onSelectRow(nodeId, 'range');
    } else if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      onSelectRow(nodeId, 'toggle');
    } else {
      onZoomTo(nodeId);
    }
  }

  return (
    <div className="rem" data-depth={depth}>
      <div
        className={`rem-row ${dropHint ? `drop-${dropHint}` : ''} ${node.isCard ? 'is-card' : ''} ${isSelected ? 'is-selected' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={() => setDropHint(null)}
        onDrop={handleDrop}
      >
        <div className="rem-gutter">
          <button
            type="button"
            className="rem-handle"
            draggable
            onDragStart={handleDragStart}
            onDragEnd={() => { draggingId = null; setDropHint(null); }}
            title="Drag to move · click to zoom in"
            onClick={() => onZoomTo(nodeId)}
          >
            ⠿
          </button>
          {hasChildren ? (
            <button
              type="button"
              className="rem-collapse"
              onClick={() => toggleCollapsed(nodeId)}
              aria-label={node.collapsed ? 'Expand' : 'Collapse'}
              aria-expanded={!node.collapsed}
            >
              {node.collapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="rem-collapse rem-collapse-empty" />
          )}
          <button
            type="button"
            className={`rem-bullet ${node.collapsed && hasChildren ? 'has-hidden' : ''} ${isSelected ? 'is-selected' : ''}`}
            onClick={handleBulletClick}
            aria-pressed={isSelected}
            title="Click to zoom in · ⌘/Ctrl-click to select · Shift-click to extend"
          >
            <span className="rem-bullet-dot" />
          </button>
        </div>

        <div className="rem-body">
          {/* Node views inside this editor need to know which rem they are in. */}
          <RemContext.Provider value={remContextValue}>
            <EditorContent editor={editor} />
          </RemContext.Provider>
        </div>

        <div className="rem-actions">
          {node.isCard && (
            isClozeRem ? (
              <span className="rem-card-badge rem-card-badge-cloze" title="Cloze rem — one card per blank">
                ⌷ {liveCards.length}
              </span>
            ) : (
              <button
                type="button"
                className="rem-card-badge"
                onClick={() => toggleCardDirection(nodeId)}
                title={
                  node.cardDirection === 'both'
                    ? 'Two-way card — click to test the forward direction only'
                    : 'Forward card — click to also test the reverse'
                }
              >
                {node.cardDirection === 'both' ? '⇄' : '→'} {liveCards.length}
              </button>
            )
          )}
          <button
            type="button"
            className="rem-action"
            onClick={() => void copyLinkToRem(nodeId)}
            title="Copy a [[link]] to this rem"
          >
            ⚯
          </button>
          <button type="button" className="rem-action" onClick={() => setShowEmbedPicker(true)} title="Embed another rem">⧈</button>
          <button type="button" className="rem-action" onClick={handleAddChild} title="Add a child rem">+</button>
          <button type="button" className="rem-action rem-action-danger" onClick={() => deleteNode(nodeId)} title="Delete this rem">×</button>
        </div>
      </div>

      {!node.collapsed && hasChildren && (
        <div className="rem-children">
          {children.map((child) => (
            <OutlinerNode
              key={child.id}
              nodeId={child.id}
              depth={depth + 1}
              onFocusRequest={onFocusRequest}
              focusedNodeId={focusedNodeId}
              onZoomTo={onZoomTo}
              ancestorIds={chain}
            />
          ))}
        </div>
      )}

      {showEmbedPicker && (
        <SearchOmnibar
          onClose={() => setShowEmbedPicker(false)}
          onSelect={handleEmbedSelect}
          placeholder="Embed a page or rem..."
        />
      )}
    </div>
  );
}
