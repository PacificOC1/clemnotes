import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getAllPages, createPage } from './db/repository';
import { OutlinerNode } from './components/OutlinerNode';
import './App.css';

function App() {
  const pages = useLiveQuery(() => getAllPages(), []) ?? [];
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  async function handleNewPage() {
    const page = await createPage('Untitled');
    setActivePageId(page.id);
    setFocusedNodeId(page.id);
  }

  const activePage = pages.find((p) => p.id === activePageId) ?? pages[0] ?? null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="new-page-btn" onClick={handleNewPage}>
          + New Page
        </button>
        <ul className="page-list">
          {pages.map((page) => (
            <li
              key={page.id}
              className={page.id === activePage?.id ? 'active' : ''}
              onClick={() => setActivePageId(page.id)}
            >
              {page.content || 'Untitled'}
            </li>
          ))}
        </ul>
      </aside>

      <main className="editor-area">
        {activePage ? (
          <OutlinerNode
            key={activePage.id}
            nodeId={activePage.id}
            depth={0}
            onFocusRequest={setFocusedNodeId}
            focusedNodeId={focusedNodeId}
          />
        ) : (
          <div className="empty-state">
            <p>No pages yet.</p>
            <button onClick={handleNewPage}>Create your first page</button>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
