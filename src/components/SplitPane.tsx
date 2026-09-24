import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getBreadcrumbPath } from '../db/repository';
import { OutlinerNode } from './OutlinerNode';
import { BacklinksPanel } from './BacklinksPanel';
import { UnlinkedReferences } from './UnlinkedReferences';
import { Breadcrumbs } from './Breadcrumbs';
import { ErrorBoundary } from './ErrorBoundary';
import { NavigationContext } from '../context/NavigationContext';
import { SelectionContext } from '../context/SelectionContext';

interface Props {
  nodeId: string;
  /** Navigate this pane. */
  onNavigate: (nodeId: string) => void;
  /** Open something in the main pane instead. */
  onOpenInMain: (nodeId: string) => void;
  onSwap: () => void;
  onClose: () => void;
}

/** Selection is the main pane's: bulk operations act on what that pane shows. */
const NO_SELECTION = { selected: new Set<string>() as ReadonlySet<string>, onSelectRow: () => {}, clear: () => {} };

/**
 * The second document (#43): source on one side, your own writing on the
 * other.
 *
 * It is the same outline — the same `OutlinerNode` bound to another rem — so
 * everything editable in the main pane is editable here, and a rem open in
 * both updates in both. Links clicked in this pane navigate this pane;
 * shift-clicking one sends it to the main pane. It lives in the URL
 * (`#/notes/<main>/split/<this>`), so back, forward and reload keep it.
 */
export function SplitPane({ nodeId, onNavigate, onOpenInMain, onSwap, onClose }: Props) {
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const pathQuery = useLiveQuery(async () => ({ forId: nodeId, path: await getBreadcrumbPath(nodeId) }), [nodeId]);
  const path = pathQuery?.forId === nodeId ? pathQuery.path : null;
  const navigation = useMemo(
    () => ({ onZoomTo: onNavigate, onOpenInSplit: onOpenInMain }),
    [onNavigate, onOpenInMain]
  );
  const title = path?.[path.length - 1]?.plainText.trim() || 'Untitled';

  return (
    <section className="split-pane" aria-label={`Beside: ${title}`}>
      <header className="split-head">
        {path && path.length > 1 ? (
          <Breadcrumbs path={path} onNavigate={onNavigate} />
        ) : (
          <span className="split-title">{title}</span>
        )}
        <div className="topbar-spacer" />
        <button type="button" className="icon-btn" onClick={onSwap} title="Swap the two documents" aria-label="Swap panes">
          ⇄
        </button>
        <button type="button" className="icon-btn" onClick={onClose} title="Close this pane" aria-label="Close pane">
          ✕
        </button>
      </header>
      <div className="split-content">
        <ErrorBoundary key={nodeId} onEscape={onClose}>
          {path && path.length === 0 ? (
            <div className="empty-state">
              <p>That rem isn't in this notebook any more.</p>
              <button type="button" className="ghost-btn" onClick={onClose}>
                Close this pane
              </button>
            </div>
          ) : (
            <NavigationContext.Provider value={navigation}>
              <SelectionContext.Provider value={NO_SELECTION}>
                <div className="document">
                  <OutlinerNode
                    key={nodeId}
                    nodeId={nodeId}
                    depth={0}
                    onFocusRequest={setFocusedNodeId}
                    focusedNodeId={focusedNodeId}
                    onZoomTo={onNavigate}
                    isRoot
                  />
                  <BacklinksPanel nodeId={nodeId} onZoomTo={onNavigate} />
                  <UnlinkedReferences key={nodeId} nodeId={nodeId} onZoomTo={onNavigate} />
                </div>
              </SelectionContext.Provider>
            </NavigationContext.Provider>
          )}
        </ErrorBoundary>
      </div>
    </section>
  );
}
