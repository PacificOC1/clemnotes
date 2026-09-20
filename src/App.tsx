import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Editor } from '@tiptap/react';
import {
  getAllPages,
  createPage,
  createPortalChild,
  getBreadcrumbPath,
  deleteNode,
  deleteNodes,
  flattenVisible,
  indentNodes,
  outdentNodes,
} from './db/repository';
import { applyRowClick } from './db/selection';
import { copyRemsAsMarkdown } from './db/clipboard';
import { undoLast } from './db/undo';
import { getCardStats } from './db/cardRepository';
import { seedLatexTutorial } from './db/seedLatexTutorial';
import { OutlinerNode } from './components/OutlinerNode';
import { BacklinksPanel } from './components/BacklinksPanel';
import { Breadcrumbs } from './components/Breadcrumbs';
import { SearchOmnibar } from './components/SearchOmnibar';
import { FormattingBubble } from './components/FormattingBubble';
import { EditorMenus } from './components/EditorMenus';
import { SyncPanel } from './components/SyncPanel';
import { BackupPanel } from './components/BackupPanel';
import { PageSidebar } from './components/PageSidebar';
import { DictionaryView } from './components/DictionaryView';
import { DictionaryEntryModal } from './components/DictionaryEntryModal';
import { ReviewView } from './components/ReviewView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SelectionBar } from './components/SelectionBar';
import { UndoToast } from './components/UndoToast';
import { Shortcuts } from './components/Shortcuts';
import { SelectionContext } from './context/SelectionContext';
import { NavigationContext } from './context/NavigationContext';
import { DictionaryProvider, useDictionary } from './context/DictionaryContext';
import { ActiveEditorContext } from './context/ActiveEditorContext';
import { useRoute } from './router/useRoute';
import type { AppTab, Route } from './router/route';
import './App.css';

const SIDEBAR_KEY = 'clemnotes:sidebar-open';

interface WorkspaceProps {
  route: Route;
  navigate: (next: Route, options?: { replace?: boolean }) => void;
}

function Workspace({ route, navigate }: WorkspaceProps) {
  const pages = useLiveQuery(() => getAllPages(), []) ?? [];
  const stats = useLiveQuery(() => getCardStats(), []) ?? null;
  const { entries, activeTab, setActiveTab } = useDictionary();

  // The zoomed rem — a top-level page or any nested rem — comes from the URL,
  // so back, forward, reload and a shared link all mean the same thing.
  const viewNodeId = route.nodeId;
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);
  /** The rows on screen, in display order — what a shift-click range spans. */
  const visibleOrderRef = useRef<string[]>([]);
  const [embedTargetId, setEmbedTargetId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  const setActive = useCallback((editor: Editor | null, nodeId: string | null) => {
    setActiveEditor(editor);
    setActiveNodeId(nodeId);
  }, []);

  const activeRootId = viewNodeId ?? pages[0]?.id ?? null;
  // The result carries the id it was asked about. Without that, a result that
  // arrived for the *previous* rem looks like an answer about the current one —
  // and since the answer for "no rem at all" is an empty path, zooming into a
  // freshly created page read as "that rem does not exist" and bounced straight
  // back out again.
  const breadcrumbQuery = useLiveQuery(
    async () => ({
      forId: activeRootId,
      path: activeRootId ? await getBreadcrumbPath(activeRootId) : [],
    }),
    [activeRootId]
  );
  const breadcrumbPath = breadcrumbQuery?.forId === activeRootId ? breadcrumbQuery.path : [];

  const handleZoomTo = useCallback(
    (nodeId: string) => {
      setFocusedNodeId(null);
      navigate({ tab: 'notes', nodeId });
    },
    [navigate]
  );

  /**
   * A link to a rem that has since been deleted — or that belongs to a
   * notebook this browser doesn't have — leaves the URL pointing at nothing.
   * `getBreadcrumbPath` comes back empty for a rem that isn't there, so drop
   * to the first page and *replace* the entry, because a route that was never
   * valid should not be somewhere `back` can return to.
   */
  useEffect(() => {
    if (!route.nodeId || breadcrumbQuery === undefined) return;
    if (breadcrumbQuery.forId !== route.nodeId) return;
    if (breadcrumbQuery.path.length === 0) {
      navigate({ tab: 'notes', nodeId: null }, { replace: true });
    }
  }, [route.nodeId, breadcrumbQuery, navigate]);

  const handleEmbed = useCallback((nodeId: string) => setEmbedTargetId(nodeId), []);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    anchorRef.current = null;
  }, []);

  /**
   * Selecting a row. The visible order is read fresh on each click rather than
   * kept in state: it changes whenever anything is collapsed, moved or typed,
   * and a stale copy would silently select the wrong range.
   */
  const handleSelectRow = useCallback(
    async (nodeId: string, mode: 'toggle' | 'range') => {
      const order = activeRootId ? await flattenVisible(activeRootId) : [];
      visibleOrderRef.current = order;
      const next = applyRowClick(selected, anchorRef.current, nodeId, order, mode);
      anchorRef.current = next.anchor;
      setSelected(next.selected);
    },
    [activeRootId, selected]
  );

  const selectionValue = useMemo(
    () => ({
      selected,
      onSelectRow: (nodeId: string, mode: 'toggle' | 'range') => void handleSelectRow(nodeId, mode),
      clear: clearSelection,
    }),
    [selected, handleSelectRow, clearSelection]
  );

  /**
   * The keydown listener is registered once, so it cannot close over state.
   * These refs are what it reads instead.
   */
  const selectedRef = useRef<ReadonlySet<string>>(selected);
  /** The focused editor, for deciding who owns ⌘Z. */
  const activeEditorRef = useRef<Editor | null>(null);
  const indentSelectionRef = useRef<() => Promise<void>>(async () => {});
  const outdentSelectionRef = useRef<() => Promise<void>>(async () => {});

  /** Run a bulk operation over the selection, then let it go. */
  const runOnSelection = useCallback(
    async (op: (ids: string[], order: string[]) => Promise<unknown>) => {
      const ids = [...selected];
      if (ids.length === 0) return;
      const order = activeRootId ? await flattenVisible(activeRootId) : visibleOrderRef.current;
      await op(ids, order);
      clearSelection();
    },
    [selected, activeRootId, clearSelection]
  );

  const indentSelection = useCallback(() => runOnSelection(indentNodes), [runOnSelection]);
  const outdentSelection = useCallback(() => runOnSelection(outdentNodes), [runOnSelection]);
  const deleteSelection = useCallback(() => runOnSelection(deleteNodes), [runOnSelection]);
  const copySelection = useCallback(() => copyRemsAsMarkdown([...selected]), [selected]);

  useEffect(() => {
    activeEditorRef.current = activeEditor;
  }, [activeEditor]);

  useEffect(() => {
    selectedRef.current = selected;
    indentSelectionRef.current = indentSelection;
    outdentSelectionRef.current = outdentSelection;
  }, [selected, indentSelection, outdentSelection]);

  // A selection belongs to the document you were looking at; carrying it to
  // another one would act on rows that are no longer on screen.
  useEffect(() => {
    clearSelection();
  }, [activeRootId, clearSelection]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_KEY);
      if (stored !== null) setSidebarOpen(stored === 'true');
    } catch {
      // Private windows and blocked site data both throw here; the default is fine.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarOpen));
    } catch {
      // Non-fatal: the sidebar just won't remember its state next time.
    }
  }, [sidebarOpen]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (meta && e.key === '\\') {
        e.preventDefault();
        setSidebarOpen((open) => !open);
      }
      if (meta && e.key === '/') {
        e.preventDefault();
        setShortcutsOpen((open) => !open);
      }
      /**
       * ⌘Z belongs to the focused editor while it still has typing to undo —
       * that is the more common intent and the one you would be surprised to
       * lose. Once its history is spent, the structural stack takes over.
       */
      if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        const editor = activeEditorRef.current;
        if (!editor || !editor.can().undo()) {
          e.preventDefault();
          void undoLast();
        }
      }
      if (e.key === 'Escape') {
        setShortcutsOpen(false);
        setSelected((current) => (current.size === 0 ? current : new Set()));
      }
      // Tab and Shift+Tab already indent the focused rem; with a selection
      // they act on all of it instead, and the editor must not also handle it.
      if (e.key === 'Tab' && selectedRef.current.size > 0) {
        e.preventDefault();
        void (e.shiftKey ? outdentSelectionRef.current() : indentSelectionRef.current());
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  async function handleNewPage() {
    const page = await createPage('Untitled');
    handleZoomTo(page.id);
    setFocusedNodeId(page.id);
  }

  /**
   * Install the built-in LaTeX course, or just open it when it's already
   * there — re-adding it would leave two copies with two sets of cards, which
   * is never what the button meant. Deleting the page and pressing it again
   * does give you a fresh copy, since a soft-deleted page stops counting.
   */
  async function handleAddLatexCourse() {
    const result = await seedLatexTutorial();
    handleZoomTo(result.pageId);
  }

  async function handleDeletePage(pageId: string, event: React.MouseEvent) {
    event.stopPropagation();
    const page = pages.find((p) => p.id === pageId);
    const label = page?.plainText.trim() || 'Untitled';
    if (!window.confirm(`Delete "${label}" and everything in it?`)) return;

    const viewingThisPage = breadcrumbPath[0]?.id === pageId || activeRootId === pageId;
    await deleteNode(pageId);

    if (viewingThisPage) {
      const remaining = pages.filter((p) => p.id !== pageId);
      setFocusedNodeId(null);
      // Replace, not push: going "back" to a page you just deleted is not a
      // useful place to end up.
      navigate({ tab: 'notes', nodeId: remaining[0]?.id ?? null }, { replace: true });
    }
  }

  const dueCount = stats?.due ?? 0;
  const parentOfView = breadcrumbPath.length > 1 ? breadcrumbPath[breadcrumbPath.length - 2] : null;

  return (
    <NavigationContext.Provider value={{ onZoomTo: handleZoomTo }}>
      <SelectionContext.Provider value={selectionValue}>
      <ActiveEditorContext.Provider value={{ activeEditor, activeNodeId, setActive }}>
        <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
          <aside className="sidebar">
            <div className="sidebar-head">
              <span className="sidebar-brand">Clemnotes</span>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setSidebarOpen(false)}
                title="Hide sidebar  ⌘\"
                aria-label="Hide sidebar"
              >
                ⇤
              </button>
            </div>

            <div className="sidebar-nav">
              <button type="button" className="nav-item nav-search" onClick={() => setSearchOpen(true)}>
                <span className="nav-icon">⌕</span>
                <span className="nav-label">Search</span>
                <kbd>⌘K</kbd>
              </button>
              <button
                type="button"
                className={`nav-item ${activeTab === 'notes' ? 'active' : ''}`}
                onClick={() => setActiveTab('notes')}
              >
                <span className="nav-icon">▤</span>
                <span className="nav-label">Notes</span>
              </button>
              <button
                type="button"
                className={`nav-item ${activeTab === 'review' ? 'active' : ''}`}
                onClick={() => setActiveTab('review')}
              >
                <span className="nav-icon">🂠</span>
                <span className="nav-label">Flashcards</span>
                {dueCount > 0 && <span className="nav-badge nav-badge-due">{dueCount}</span>}
              </button>
              <button
                type="button"
                className={`nav-item ${activeTab === 'dictionary' ? 'active' : ''}`}
                onClick={() => setActiveTab('dictionary')}
              >
                <span className="nav-icon">⌸</span>
                <span className="nav-label">Definitions</span>
                {entries.length > 0 && <span className="nav-badge">{entries.length}</span>}
              </button>
            </div>

            <PageSidebar
              pages={pages}
              activeNodeId={activeRootId}
              breadcrumbRootId={breadcrumbPath[0]?.id}
              onSelectPage={handleZoomTo}
              onDeletePage={handleDeletePage}
              onNewPage={handleNewPage}
              onAddLatexCourse={() => void handleAddLatexCourse()}
            />

            <SyncPanel />
            <BackupPanel />
          </aside>

          <div className="main">
            <header className="topbar">
              {!sidebarOpen && (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setSidebarOpen(true)}
                  title="Show sidebar  ⌘\"
                  aria-label="Show sidebar"
                >
                  ⇥
                </button>
              )}
              {activeTab === 'notes' && (
                <>
                  {parentOfView && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => handleZoomTo(parentOfView.id)}
                      title="Zoom out one level"
                      aria-label="Zoom out"
                    >
                      ↰
                    </button>
                  )}
                  <Breadcrumbs path={breadcrumbPath} onNavigate={handleZoomTo} />
                </>
              )}
              <div className="topbar-spacer" />
              <button type="button" className="ghost-btn" onClick={handleNewPage}>+ New page</button>
            </header>

            <main className="content">
              {/* Scoped to the document, so a bad rem leaves the sidebar, the
                  tabs and the URL working — something to walk away with. */}
              <ErrorBoundary
                key={`${activeTab}:${activeRootId ?? ''}`}
                onEscape={() => navigate({ tab: 'notes', nodeId: null }, { replace: true })}
              >
              {activeTab === 'notes' && (
                activeRootId ? (
                  <div className="document">
                    <OutlinerNode
                      key={activeRootId}
                      nodeId={activeRootId}
                      depth={0}
                      onFocusRequest={setFocusedNodeId}
                      focusedNodeId={focusedNodeId}
                      onZoomTo={handleZoomTo}
                      isRoot
                    />
                    <BacklinksPanel nodeId={activeRootId} onZoomTo={handleZoomTo} />
                  </div>
                ) : (
                  <div className="empty-state">
                    <h2>Nothing here yet</h2>
                    <p>Pages are just rems with no parent. Make one and start typing.</p>
                    <button type="button" className="primary-btn" onClick={handleNewPage}>
                      Create your first page
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => void handleAddLatexCourse()}
                    >
                      Or add the LaTeX course
                    </button>
                  </div>
                )
              )}
              {activeTab === 'review' && <ReviewView onZoomTo={handleZoomTo} />}
              {activeTab === 'dictionary' && <DictionaryView />}
              </ErrorBoundary>
            </main>
          </div>

          {searchOpen && (
            <SearchOmnibar onClose={() => setSearchOpen(false)} onSelect={handleZoomTo} />
          )}
          {embedTargetId && (
            <SearchOmnibar
              placeholder="Embed a page or rem..."
              onClose={() => setEmbedTargetId(null)}
              onSelect={(targetId) => {
                const parentId = embedTargetId;
                setEmbedTargetId(null);
                void createPortalChild(parentId, targetId).then((created) => {
                  if (!created) {
                    window.alert("A rem can't embed itself or anything it already sits inside.");
                  }
                });
              }}
            />
          )}
          <EditorMenus onEmbed={handleEmbed} onZoomTo={handleZoomTo} />
          <FormattingBubble />
          <DictionaryEntryModal />
          <SelectionBar
            count={selected.size}
            onIndent={indentSelection}
            onOutdent={outdentSelection}
            onCopy={copySelection}
            onDelete={deleteSelection}
            onClear={clearSelection}
          />
          <UndoToast />
          {shortcutsOpen && <Shortcuts onClose={() => setShortcutsOpen(false)} />}
        </div>
      </ActiveEditorContext.Provider>
      </SelectionContext.Provider>
    </NavigationContext.Provider>
  );
}

export default function App() {
  const { route, navigate } = useRoute();

  // Switching to Flashcards and back should return you to the rem you were
  // reading, not to the top of the first page. The URL for a non-notes tab
  // carries no rem, so the last one is remembered here instead.
  const lastNoteRef = useRef<string | null>(null);
  useEffect(() => {
    if (route.tab === 'notes') lastNoteRef.current = route.nodeId;
  }, [route.tab, route.nodeId]);

  const setActiveTab = useCallback(
    (tab: AppTab) => navigate({ tab, nodeId: tab === 'notes' ? lastNoteRef.current : null }),
    [navigate]
  );

  return (
    <DictionaryProvider activeTab={route.tab} setActiveTab={setActiveTab}>
      <Workspace route={route} navigate={navigate} />
    </DictionaryProvider>
  );
}
