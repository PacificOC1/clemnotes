import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Editor } from '@tiptap/react';
import {
  getAllPages,
  createPage,
  createPortalChild,
  getBreadcrumbPath,
  deleteNode,
} from './db/repository';
import { getCardStats } from './db/cardRepository';
import { OutlinerNode } from './components/OutlinerNode';
import { BacklinksPanel } from './components/BacklinksPanel';
import { Breadcrumbs } from './components/Breadcrumbs';
import { SearchOmnibar } from './components/SearchOmnibar';
import { FormattingBubble } from './components/FormattingBubble';
import { EditorMenus } from './components/EditorMenus';
import { SyncPanel } from './components/SyncPanel';
import { PageSidebar } from './components/PageSidebar';
import { DictionaryView } from './components/DictionaryView';
import { DictionaryEntryModal } from './components/DictionaryEntryModal';
import { ReviewView } from './components/ReviewView';
import { NavigationContext } from './context/NavigationContext';
import { DictionaryProvider, useDictionary } from './context/DictionaryContext';
import { ActiveEditorContext } from './context/ActiveEditorContext';
import './App.css';

const SIDEBAR_KEY = 'clemnotes:sidebar-open';

function Workspace() {
  const pages = useLiveQuery(() => getAllPages(), []) ?? [];
  const stats = useLiveQuery(() => getCardStats(), []) ?? null;
  const { entries, activeTab, setActiveTab } = useDictionary();

  // viewNodeId is whatever node is currently "zoomed into" as the page root —
  // it can be a top-level page OR any nested rem.
  const [viewNodeId, setViewNodeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [embedTargetId, setEmbedTargetId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  const setActive = useCallback((editor: Editor | null, nodeId: string | null) => {
    setActiveEditor(editor);
    setActiveNodeId(nodeId);
  }, []);

  const activeRootId = viewNodeId ?? pages[0]?.id ?? null;
  const breadcrumbPath =
    useLiveQuery(
      () => (activeRootId ? getBreadcrumbPath(activeRootId) : Promise.resolve([])),
      [activeRootId]
    ) ?? [];

  const handleZoomTo = useCallback(
    (nodeId: string) => {
      setViewNodeId(nodeId);
      setFocusedNodeId(null);
      setActiveTab('notes');
    },
    [setActiveTab]
  );

  const handleEmbed = useCallback((nodeId: string) => setEmbedTargetId(nodeId), []);

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
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  async function handleNewPage() {
    const page = await createPage('Untitled');
    handleZoomTo(page.id);
    setFocusedNodeId(page.id);
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
      setViewNodeId(remaining[0]?.id ?? null);
      setFocusedNodeId(null);
    }
  }

  const dueCount = stats?.due ?? 0;
  const parentOfView = breadcrumbPath.length > 1 ? breadcrumbPath[breadcrumbPath.length - 2] : null;

  return (
    <NavigationContext.Provider value={{ onZoomTo: handleZoomTo }}>
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
            />

            <SyncPanel />
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
                  </div>
                )
              )}
              {activeTab === 'review' && <ReviewView onZoomTo={handleZoomTo} />}
              {activeTab === 'dictionary' && <DictionaryView />}
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
                void createPortalChild(embedTargetId, targetId);
                setEmbedTargetId(null);
              }}
            />
          )}
          <EditorMenus onEmbed={handleEmbed} onZoomTo={handleZoomTo} />
          <FormattingBubble />
          <DictionaryEntryModal />
        </div>
      </ActiveEditorContext.Provider>
    </NavigationContext.Provider>
  );
}

export default function App() {
  return (
    <DictionaryProvider>
      <Workspace />
    </DictionaryProvider>
  );
}
