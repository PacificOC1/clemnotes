import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getAllPages, createPage, getBreadcrumbPath, deleteNode } from './db/repository';
import { OutlinerNode } from './components/OutlinerNode';
import { BacklinksPanel } from './components/BacklinksPanel';
import { Breadcrumbs } from './components/Breadcrumbs';
import { SearchOmnibar } from './components/SearchOmnibar';
import { BottomToolbar } from './components/BottomToolbar';
import { SyncPanel } from './components/SyncPanel';
import { PageSidebar } from './components/PageSidebar';
import { DictionaryView } from './components/DictionaryView';
import { DictionaryEntryModal } from './components/DictionaryEntryModal';
import { NavigationContext } from './context/NavigationContext';
import { DictionaryProvider, useDictionary } from './context/DictionaryContext';
import { ActiveEditorContext } from './context/ActiveEditorContext';
import type { Editor } from '@tiptap/react';
import type { OutlinerNode as OutlinerNodeRecord } from './db/schema';
import './App.css';

function MainPanel({
  activeNodeId,
  breadcrumbPath,
  focusedNodeId,
  onFocusRequest,
  onZoomTo,
  onNewPage,
}: {
  activeNodeId: string | null;
  breadcrumbPath: OutlinerNodeRecord[];
  focusedNodeId: string | null;
  onFocusRequest: (nodeId: string) => void;
  onZoomTo: (nodeId: string) => void;
  onNewPage: () => void;
}) {
  const { entries, activeTab, setActiveTab } = useDictionary();

  return (
    <div className="main-panel">
      <nav className="app-tabs" aria-label="Main navigation">
        <button
          type="button"
          className={`app-tab ${activeTab === 'notes' ? 'active' : ''}`}
          onClick={() => setActiveTab('notes')}
        >
          Notes
        </button>
        <button
          type="button"
          className={`app-tab ${activeTab === 'dictionary' ? 'active' : ''}`}
          onClick={() => setActiveTab('dictionary')}
        >
          Definitions
          {entries.length > 0 && <span className="app-tab-count">{entries.length}</span>}
        </button>
      </nav>

      {activeTab === 'notes' ? (
        <main className="editor-area">
          {activeNodeId ? (
            <>
              <Breadcrumbs path={breadcrumbPath} onNavigate={onZoomTo} />
              <OutlinerNode
                key={activeNodeId}
                nodeId={activeNodeId}
                depth={0}
                onFocusRequest={onFocusRequest}
                focusedNodeId={focusedNodeId}
                onZoomTo={onZoomTo}
                isRoot
              />
              <BacklinksPanel nodeId={activeNodeId} onZoomTo={onZoomTo} />
            </>
          ) : (
            <div className="empty-state">
              <p>No pages yet.</p>
              <button onClick={onNewPage}>Create your first page</button>
            </div>
          )}
        </main>
      ) : (
        <main className="editor-area dictionary-tab">
          <DictionaryView />
        </main>
      )}
    </div>
  );
}

function App() {
  const pages = useLiveQuery(() => getAllPages(), []) ?? [];
  // viewNodeId is whatever node is currently "zoomed into" as the page root —
  // it can be a top-level page OR any nested bullet.
  const [viewNodeId, setViewNodeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);

  const activeNodeId = viewNodeId ?? pages[0]?.id ?? null;
  const breadcrumbPath = useLiveQuery(
    () => (activeNodeId ? getBreadcrumbPath(activeNodeId) : Promise.resolve([])),
    [activeNodeId]
  ) ?? [];

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  async function handleNewPage() {
    const page = await createPage('Untitled');
    setViewNodeId(page.id);
    setFocusedNodeId(page.id);
  }

  function handleZoomTo(nodeId: string) {
    setViewNodeId(nodeId);
    setFocusedNodeId(null);
  }

  async function handleDeletePage(pageId: string, event: React.MouseEvent) {
    event.stopPropagation();
    const page = pages.find((p) => p.id === pageId);
    const label = page?.plainText.trim() || 'Untitled';
    if (!window.confirm(`Delete "${label}" and all its content?`)) return;

    const viewingThisPage = breadcrumbPath[0]?.id === pageId || activeNodeId === pageId;

    await deleteNode(pageId);

    if (viewingThisPage) {
      const remaining = pages.filter((p) => p.id !== pageId);
      setViewNodeId(remaining[0]?.id ?? null);
      setFocusedNodeId(null);
    }
  }

  return (
    <DictionaryProvider>
      <NavigationContext.Provider value={{ onZoomTo: handleZoomTo }}>
        <ActiveEditorContext.Provider value={{ activeEditor, setActiveEditor }}>
          <div className="app-shell">
            <aside className="sidebar">
              <div className="sidebar-top">
                <button className="new-page-btn" onClick={handleNewPage}>
                  + New Page
                </button>
                <button className="search-trigger-btn" onClick={() => setSearchOpen(true)}>
                  🔍 Search <span className="kbd-hint">⌘K</span>
                </button>
              </div>
              <PageSidebar
                pages={pages}
                activeNodeId={activeNodeId}
                breadcrumbRootId={breadcrumbPath[0]?.id}
                onSelectPage={handleZoomTo}
                onDeletePage={handleDeletePage}
              />
              <SyncPanel />
            </aside>

            <MainPanel
              activeNodeId={activeNodeId}
              breadcrumbPath={breadcrumbPath}
              focusedNodeId={focusedNodeId}
              onFocusRequest={setFocusedNodeId}
              onZoomTo={handleZoomTo}
              onNewPage={handleNewPage}
            />

            {searchOpen && <SearchOmnibar onClose={() => setSearchOpen(false)} onSelect={handleZoomTo} />}
            <DictionaryEntryModal />
            <BottomToolbar />
          </div>
        </ActiveEditorContext.Provider>
      </NavigationContext.Provider>
    </DictionaryProvider>
  );
}

export default App;
