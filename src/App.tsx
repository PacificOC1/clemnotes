import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getAllPages, createPage, getBreadcrumbPath } from './db/repository';
import { OutlinerNode } from './components/OutlinerNode';
import { BacklinksPanel } from './components/BacklinksPanel';
import { Breadcrumbs } from './components/Breadcrumbs';
import { SearchOmnibar } from './components/SearchOmnibar';
import { BottomToolbar } from './components/BottomToolbar';
import { SyncPanel } from './components/SyncPanel';
import { NavigationContext } from './context/NavigationContext';
import { ActiveEditorContext } from './context/ActiveEditorContext';
import type { Editor } from '@tiptap/react';
import './App.css';

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

  const isActivePage = (pageId: string) => pageId === activeNodeId || breadcrumbPath[0]?.id === pageId;

  return (
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
            <ul className="page-list">
              {pages.map((page) => (
                <li
                  key={page.id}
                  className={isActivePage(page.id) ? 'active' : ''}
                  onClick={() => handleZoomTo(page.id)}
                >
                  {page.plainText || 'Untitled'}
                </li>
              ))}
            </ul>
            <SyncPanel />
          </aside>

          <main className="editor-area">
            {activeNodeId ? (
              <>
                <Breadcrumbs path={breadcrumbPath} onNavigate={handleZoomTo} />
                <OutlinerNode
                  key={activeNodeId}
                  nodeId={activeNodeId}
                  depth={0}
                  onFocusRequest={setFocusedNodeId}
                  focusedNodeId={focusedNodeId}
                  onZoomTo={handleZoomTo}
                  isRoot
                />
                <BacklinksPanel nodeId={activeNodeId} onZoomTo={handleZoomTo} />
              </>
            ) : (
              <div className="empty-state">
                <p>No pages yet.</p>
                <button onClick={handleNewPage}>Create your first page</button>
              </div>
            )}
          </main>

          {searchOpen && <SearchOmnibar onClose={() => setSearchOpen(false)} onSelect={handleZoomTo} />}
          <BottomToolbar />
        </div>
      </ActiveEditorContext.Provider>
    </NavigationContext.Provider>
  );
}

export default App;
