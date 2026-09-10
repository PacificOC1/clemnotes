import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  createFolder,
  deleteFolder,
  getAllFolders,
  movePageToFolder,
  toggleFolderCollapsed,
  updateFolderName,
} from '../db/folderRepository';
import { createPage } from '../db/repository';
import type { OutlinerNode, PageFolder } from '../db/schema';

interface PageSidebarProps {
  pages: OutlinerNode[];
  activeNodeId: string | null;
  breadcrumbRootId: string | undefined;
  onSelectPage: (pageId: string) => void;
  onDeletePage: (pageId: string, event: React.MouseEvent) => void;
  onNewPage: () => void;
  onAddLatexCourse: () => void;
}

/** The page being dragged in the sidebar — see the note in OutlinerNode about why this isn't state. */
let draggingPageId: string | null = null;

/** See the note in OutlinerNode: a private type keeps editors from inserting the id as text. */
const PAGE_DRAG_TYPE = 'application/x-clemnotes-page';

function PageRow({
  page,
  active,
  folders,
  folderId,
  onSelectPage,
  onDeletePage,
  onMovePage,
}: {
  page: OutlinerNode;
  active: boolean;
  folders: PageFolder[];
  folderId: string | null;
  onSelectPage: (pageId: string) => void;
  onDeletePage: (pageId: string, event: React.MouseEvent) => void;
  onMovePage: (pageId: string, folderId: string | null) => void;
}) {
  return (
    <li
      className={`page-row ${active ? 'active' : ''}`}
      draggable
      onDragStart={(e) => {
        draggingPageId = page.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(PAGE_DRAG_TYPE, page.id);
      }}
      onDragEnd={() => { draggingPageId = null; }}
    >
      <button type="button" className="page-row-btn" onClick={() => onSelectPage(page.id)}>
        <span className="page-row-icon">▤</span>
        <span className="page-row-label">{page.plainText || 'Untitled'}</span>
      </button>
      <div className="page-row-actions">
        <select
          className="page-folder-select"
          value={folderId ?? ''}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onMovePage(page.id, e.target.value || null)}
          aria-label={`Move ${page.plainText || 'Untitled'} to a folder`}
          title="Move to folder"
        >
          <option value="">Unfiled</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>{folder.name}</option>
          ))}
        </select>
        <button
          type="button"
          className="page-row-delete"
          onClick={(e) => onDeletePage(page.id, e)}
          aria-label={`Delete ${page.plainText || 'Untitled'}`}
          title="Delete page"
        >
          ×
        </button>
      </div>
    </li>
  );
}

export function PageSidebar({
  pages,
  activeNodeId,
  breadcrumbRootId,
  onSelectPage,
  onDeletePage,
  onNewPage,
  onAddLatexCourse,
}: PageSidebarProps) {
  const folders = useLiveQuery(() => getAllFolders(), []) ?? [];
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);

  const pagesById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);

  const filedPageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const folder of folders) for (const id of folder.pageIds) ids.add(id);
    return ids;
  }, [folders]);

  const unfiledPages = useMemo(
    () => pages.filter((p) => !filedPageIds.has(p.id)),
    [pages, filedPageIds]
  );

  const pageFolderId = useMemo(() => {
    const map = new Map<string, string>();
    for (const folder of folders) for (const id of folder.pageIds) map.set(id, folder.id);
    return map;
  }, [folders]);

  const isActivePage = (pageId: string) => pageId === activeNodeId || breadcrumbRootId === pageId;

  async function handleNewPageInFolder(folderId: string, event: React.MouseEvent) {
    event.stopPropagation();
    const page = await createPage('Untitled', folderId);
    onSelectPage(page.id);
  }

  async function handleDeleteFolder(folderId: string, event: React.MouseEvent) {
    event.stopPropagation();
    const folder = folders.find((f) => f.id === folderId);
    if (!folder) return;
    if (!window.confirm(`Delete folder "${folder.name}"? The pages inside move to Unfiled.`)) return;
    await deleteFolder(folderId);
  }

  function startRename(folder: PageFolder) {
    setRenamingFolderId(folder.id);
    setRenameValue(folder.name);
  }

  async function commitRename() {
    if (renamingFolderId) await updateFolderName(renamingFolderId, renameValue);
    setRenamingFolderId(null);
  }

  async function dropOnFolder(folderId: string | null, event: React.DragEvent) {
    event.preventDefault();
    const pageId = draggingPageId || event.dataTransfer.getData(PAGE_DRAG_TYPE);
    setDropFolderId(null);
    draggingPageId = null;
    if (pageId) await movePageToFolder(pageId, folderId);
  }

  return (
    <div className="page-sidebar">
      <div className="sidebar-section-head">
        <span className="sidebar-section-title">Documents</span>
        <div className="sidebar-section-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={onAddLatexCourse}
            title="Add the LaTeX course"
            aria-label="Add the LaTeX course"
          >
            ∑
          </button>
          <button type="button" className="icon-btn" onClick={() => void createFolder()} title="New folder">🗀</button>
          <button type="button" className="icon-btn" onClick={onNewPage} title="New page">+</button>
        </div>
      </div>

      <ul className="folder-list">
        {folders.map((folder) => {
          const folderPages = folder.pageIds
            .map((id) => pagesById.get(id))
            .filter((p): p is OutlinerNode => Boolean(p));

          return (
            <li key={folder.id} className={`folder ${dropFolderId === folder.id ? 'drop-target' : ''}`}>
              <div
                className="folder-head"
                onDragOver={(e) => { e.preventDefault(); setDropFolderId(folder.id); }}
                onDragLeave={() => setDropFolderId(null)}
                onDrop={(e) => void dropOnFolder(folder.id, e)}
              >
                <button
                  type="button"
                  className="folder-caret"
                  onClick={() => toggleFolderCollapsed(folder.id)}
                  aria-label={folder.collapsed ? 'Expand folder' : 'Collapse folder'}
                >
                  {folder.collapsed ? '▸' : '▾'}
                </button>
                {renamingFolderId === folder.id ? (
                  <input
                    className="folder-rename"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename();
                      if (e.key === 'Escape') setRenamingFolderId(null);
                    }}
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    className="folder-name"
                    onClick={() => toggleFolderCollapsed(folder.id)}
                    onDoubleClick={() => startRename(folder)}
                    title="Double-click to rename"
                  >
                    {folder.name}
                  </button>
                )}
                <span className="folder-count">{folderPages.length}</span>
                <div className="folder-actions">
                  <button type="button" className="icon-btn" onClick={(e) => void handleNewPageInFolder(folder.id, e)} title="New page here">+</button>
                  <button type="button" className="icon-btn icon-btn-danger" onClick={(e) => void handleDeleteFolder(folder.id, e)} title="Delete folder">×</button>
                </div>
              </div>

              {!folder.collapsed && (
                <ul className="page-list">
                  {folderPages.map((page) => (
                    <PageRow
                      key={page.id}
                      page={page}
                      active={isActivePage(page.id)}
                      folders={folders}
                      folderId={pageFolderId.get(page.id) ?? null}
                      onSelectPage={onSelectPage}
                      onDeletePage={onDeletePage}
                      onMovePage={(pageId, folderId) => void movePageToFolder(pageId, folderId)}
                    />
                  ))}
                  {folderPages.length === 0 && <li className="folder-empty">Drop a page here</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      <div
        className={`unfiled ${dropFolderId === '__unfiled__' ? 'drop-target' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDropFolderId('__unfiled__'); }}
        onDragLeave={() => setDropFolderId(null)}
        onDrop={(e) => void dropOnFolder(null, e)}
      >
        {folders.length > 0 && unfiledPages.length > 0 && <div className="unfiled-label">Unfiled</div>}
        <ul className="page-list">
          {unfiledPages.map((page) => (
            <PageRow
              key={page.id}
              page={page}
              active={isActivePage(page.id)}
              folders={folders}
              folderId={null}
              onSelectPage={onSelectPage}
              onDeletePage={onDeletePage}
              onMovePage={(pageId, folderId) => void movePageToFolder(pageId, folderId)}
            />
          ))}
        </ul>
        {pages.length === 0 && <div className="folder-empty">No pages yet</div>}
      </div>
    </div>
  );
}
