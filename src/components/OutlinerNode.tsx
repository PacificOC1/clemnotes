import { useState, useEffect, useId, useMemo, type MouseEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  getChildren,
  getNode,
  createFirstChild,
  createPortalChild,
  toggleCollapsed,
  ensureFirstChild,
  moveNodeRelativeTo,
  deleteNode,
  type DropPosition,
} from '../db/repository';
import { getCardsForNode, toggleCardDirection } from '../db/cardRepository';
import { copyLinkToRem } from '../db/clipboard';
import { useSelection } from '../context/SelectionContext';
import { RemContext } from '../context/RemContext';
import { SearchOmnibar } from './SearchOmnibar';
import { VersionHistory } from './VersionHistory';
import { RemText } from './RemText';
import { draggingRemId, setDraggingRemId } from './dragState';

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
  // `undefined` while loading, so "no children yet" can't be mistaken for "none".
  const loadedChildren = useLiveQuery(() => getChildren(nodeId), [nodeId]);
  const children = loadedChildren ?? [];
  // `null` rather than `undefined` for "looked, and it isn't there", so a
  // target that is missing can be told apart from one still loading.
  const portalTarget = useLiveQuery(
    async () =>
      node?.isPortal && node.portalTargetId ? ((await getNode(node.portalTargetId)) ?? null) : undefined,
    [node?.isPortal, node?.portalTargetId]
  );
  const cards = useLiveQuery(() => (node?.isCard ? getCardsForNode(nodeId) : Promise.resolve([])), [nodeId, node?.isCard]) ?? [];

  /** This row's ancestors plus itself — what the rows below it inherit. */
  const chain = useMemo(() => new Set(ancestorIds).add(nodeId), [ancestorIds, nodeId]);

  const [showEmbedPicker, setShowEmbedPicker] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [dropHint, setDropHint] = useState<DropPosition | null>(null);

  const { selected, onSelectRow } = useSelection();
  /** The row's own text names it for assistive tech — not its whole subtree. */
  const labelId = useId();
  const remContextValue = useMemo(() => ({ nodeId }), [nodeId]);

  // Older pages did not have a first bullet until the user clicked +. Keep a
  // ready-to-type slot directly beneath every page title, including those.
  useEffect(() => {
    if (isRoot && node && !node.deletedAt && loadedChildren?.length === 0) {
      void ensureFirstChild(nodeId);
    }
  }, [isRoot, nodeId, node, loadedChildren?.length]);

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
    setDraggingRemId(nodeId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(REM_DRAG_TYPE, nodeId);
  }

  function handleDragOver(event: React.DragEvent) {
    const dragging = draggingRemId();
    if (!dragging || dragging === nodeId || isRoot) return;
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
    const sourceId = draggingRemId() || event.dataTransfer.getData(REM_DRAG_TYPE);
    const position = dropHint;
    setDropHint(null);
    setDraggingRemId(null);
    if (!sourceId || !position) return;
    await moveNodeRelativeTo(sourceId, nodeId, position);
  }

  const liveCards = cards.filter((c) => !c.suspended);
  const isClozeRem = liveCards.some((c) => c.kind === 'cloze');
  const isListRem = liveCards.some((c) => c.kind === 'list');

  // Portal nodes render a live, editable embed of another node's subtree
  // instead of their own text — the embedded OutlinerNode is the exact
  // same component/subtree bound to the target id, so edits made inside
  // the portal write straight back to the real node.
  if (node.isPortal && node.portalTargetId) {
    // Re-entering something already open above us would loop forever, so show
    // a link to it instead of expanding it in place. `chain` includes this rem,
    // which also catches a portal pointed straight at itself.
    const isCircular = chain.has(node.portalTargetId);

    /**
     * The target is gone. It used to render as an empty box headed "Untitled",
     * which explained nothing and offered no way out. A deleted target still
     * has its tombstone, and with it the text it had — so the embed can say
     * what it pointed at. One that was never here at all (a rem from a
     * notebook this device hasn't synced) has only its id.
     */
    if (portalTarget === null || portalTarget?.deletedAt) {
      const was = portalTarget?.plainText.trim();
      return (
        <div className="rem" data-depth={depth} role="treeitem" aria-level={depth + 1}>
          <div className="portal-embed portal-embed-dead">
            <div className="portal-dead">
              <span className="portal-dead-text">
                {portalTarget
                  ? <>This embed pointed at <b>{was || 'an untitled rem'}</b>, which has been deleted.</>
                  : <>This embed points at a rem that isn’t in this notebook.</>}
              </span>
              <button type="button" className="portal-dead-remove" onClick={() => deleteNode(nodeId)}>
                Remove embed
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="rem" data-depth={depth} role="treeitem" aria-level={depth + 1} aria-label={`Embed of ${portalTarget?.plainText.trim() || 'a rem'}`}>
        <div className="portal-embed">
          <div className="portal-header">
            <button type="button" className="portal-header-label" onClick={() => onZoomTo(node.portalTargetId!)}>
              ↗ {portalTarget?.plainText || 'Untitled'}
            </button>
            <button type="button" className="portal-remove-btn" onClick={() => deleteNode(nodeId)} title="Remove embed" aria-label="Remove embed">
              ×
            </button>
          </div>
          <div className="portal-body" role="group">
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
        <div className="page-title" data-rem-id={nodeId}>
          <RemContext.Provider value={remContextValue}>
            <RemText
              nodeId={nodeId}
              content={node.content}
              isRoot
              focusedNodeId={focusedNodeId}
              onFocusRequest={onFocusRequest}
            />
          </RemContext.Provider>
        </div>
        <div
          className="rem-children rem-children-root"
          role="tree"
          aria-multiselectable="true"
          aria-label={`${node.plainText.trim() || 'Untitled'} — outline`}
        >
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
    <div
      className="rem"
      data-depth={depth}
      role="treeitem"
      aria-level={depth + 1}
      aria-labelledby={labelId}
      aria-selected={isSelected}
      aria-expanded={hasChildren ? !node.collapsed : undefined}
    >
      <div
        data-rem-id={nodeId}
        className={`rem-row ${dropHint ? `drop-${dropHint}` : ''} ${node.isCard ? 'is-card' : ''} ${isSelected ? 'is-selected' : ''} ${focusedNodeId === nodeId ? 'is-focused' : ''}`}
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
            onDragEnd={() => { setDraggingRemId(null); setDropHint(null); }}
            title="Drag to move · click to zoom in"
            aria-label="Zoom in (drag to move)"
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
            aria-label="Zoom in · ⌘ or Ctrl-click to select"
            title="Click to zoom in · ⌘/Ctrl-click to select · Shift-click to extend"
          >
            <span className="rem-bullet-dot" />
          </button>
        </div>

        <div className="rem-body" id={labelId}>
          {/* Node views inside this editor need to know which rem they are in. */}
          <RemContext.Provider value={remContextValue}>
            <RemText
              nodeId={nodeId}
              content={node.content}
              focusedNodeId={focusedNodeId}
              onFocusRequest={onFocusRequest}
            />
          </RemContext.Provider>
        </div>

        <div className="rem-actions">
          {node.isCard && (
            isClozeRem ? (
              <span className="rem-card-badge rem-card-badge-cloze" title="Cloze rem — one card per blank">
                ⌷ {liveCards.length}
              </span>
            ) : isListRem ? (
              <span className="rem-card-badge rem-card-badge-list" title="List card — asks for everything underneath">
                ☰ {children.length}
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
            aria-label="Copy a link to this rem"
          >
            ⚯
          </button>
          <button type="button" className="rem-action" onClick={() => setShowHistory(true)} title="Version history" aria-label="Version history">⟲</button>
          <button type="button" className="rem-action" onClick={() => setShowEmbedPicker(true)} title="Embed another rem" aria-label="Embed another rem">⧈</button>
          <button type="button" className="rem-action" onClick={handleAddChild} title="Add a child rem" aria-label="Add a child rem">+</button>
          <button type="button" className="rem-action rem-action-danger" onClick={() => deleteNode(nodeId)} title="Delete this rem" aria-label="Delete this rem">×</button>
        </div>
      </div>

      {!node.collapsed && hasChildren && (
        <div className="rem-children" role="group">
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
      {showHistory && <VersionHistory nodeId={nodeId} onClose={() => setShowHistory(false)} />}
    </div>
  );
}
