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
}

function PageRow({
  page,
  active,
  folders,
  folderId,
  onSelectPage,
  onDeletePage,
  onMovePage,
  nested,
}: {
  page: OutlinerNode;
  active: boolean;
  folders: PageFolder[];
  folderId: string | null;
  onSelectPage: (pageId: string) => void;
  onDeletePage: (pageId: string, event: React.MouseEvent) => void;
  onMovePage: (pageId: string, folderId: string | null) => void;
  nested?: boolean;
}) {
  return (
    <li className={`page-list-row ${active ? 'active' : ''} ${nested ? 'nested' : ''}`}>
      <button type="button" className="page-list-item" onClick={() => onSelectPage(page.id)}>
        {page.plainText || 'Untitled'}
      </button>
      <select
        className="page-folder-select"
        value={folderId ?? ''}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onMovePage(page.id, e.target.value || null)}
        aria-label={`Move ${page.plainText || 'Untitled'} to folder`}
        title="Move to folder"
      >
        <option value="">Unfiled</option>
        {folders.map((folder) => (
          <option key={folder.id} value={folder.id}>
            {folder.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="page-delete-btn"
        onClick={(e) => onDeletePage(page.id, e)}
        aria-label={`Delete ${page.plainText || 'Untitled'}`}
        title="Delete page"
      >
        ×
      </button>
    </li>
  );
}

export function PageSidebar({
  pages,
  activeNodeId,
  breadcrumbRootId,
  onSelectPage,
  onDeletePage,
}: PageSidebarProps) {
  const folders = useLiveQuery(() => getAllFolders(), []) ?? [];
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const pagesById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);

  const filedPageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const folder of folders) {
      for (const id of folder.pageIds) ids.add(id);
    }
    return ids;
  }, [folders]);

  const unfiledPages = useMemo(
    () => pages.filter((p) => !filedPageIds.has(p.id)),
    [pages, filedPageIds]
  );

  const pageFolderId = useMemo(() => {
    const map = new Map<string, string>();
    for (const folder of folders) {
      for (const id of folder.pageIds) map.set(id, folder.id);
    }
    return map;
  }, [folders]);

  function isActivePage(pageId: string) {
    return pageId === activeNodeId || breadcrumbRootId === pageId;
  }

  async function handleNewFolder() {
    await createFolder();
  }

  async function handleNewPageInFolder(folderId: string, event: React.MouseEvent) {
    event.stopPropagation();
    const page = await createPage('Untitled', folderId);
    onSelectPage(page.id);
  }

  async function handleDeleteFolder(folderId: string, event: React.MouseEvent) {
    event.stopPropagation();
    const folder = folders.find((f) => f.id === folderId);
    if (!folder) return;
    if (!window.confirm(`Delete folder "${folder.name}"? Pages inside will move to Unfiled.`)) return;
    await deleteFolder(folderId);
  }

  async function handleMovePage(pageId: string, folderId: string | null) {
    await movePageToFolder(pageId, folderId);
  }

  function startRename(folder: PageFolder) {
    setRenamingFolderId(folder.id);
    setRenameValue(folder.name);
  }

  async function commitRename() {
    if (renamingFolderId) {
      await updateFolderName(renamingFolderId, renameValue);
    }
    setRenamingFolderId(null);
  }

  return (
    <div className="page-sidebar">
      <div className="page-sidebar-actions">
        <button type="button" className="sidebar-secondary-btn" onClick={handleNewFolder}>
          + Folder
        </button>
      </div>

      <ul className="page-list">
        {folders.map((folder) => {
          const folderPages = folder.pageIds
            .map((id) => pagesById.get(id))
            .filter((p): p is OutlinerNode => Boolean(p));

          return (
            <li key={folder.id} className="folder-block">
              <div className="folder-header">
                <button
                  type="button"
                  className="folder-collapse-btn"
                  onClick={() => toggleFolderCollapsed(folder.id)}
                  aria-label={folder.collapsed ? 'Expand folder' : 'Collapse folder'}
                >
                  {folder.collapsed ? '▸' : '▾'}
                </button>
                {renamingFolderId === folder.id ? (
                  <input
                    className="folder-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setRenamingFolderId(null);
                    }}
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    className="folder-name-btn"
                    onDoubleClick={() => startRename(folder)}
                    title="Double-click to rename"
                  >
                    {folder.name}
                  </button>
                )}
                <span className="folder-count">{folderPages.length}</span>
                <button
                  type="button"
                  className="folder-add-page-btn"
                  onClick={(e) => handleNewPageInFolder(folder.id, e)}
                  title="New page in folder"
                >
                  +
                </button>
                <button
                  type="button"
                  className="folder-delete-btn"
                  onClick={(e) => handleDeleteFolder(folder.id, e)}
                  aria-label={`Delete folder ${folder.name}`}
                  title="Delete folder"
                >
                  ×
                </button>
              </div>
              {!folder.collapsed && folderPages.length > 0 && (
                <ul className="folder-page-list">
                  {folderPages.map((page) => (
                    <PageRow
                      key={page.id}
                      page={page}
                      active={isActivePage(page.id)}
                      folders={folders}
                      folderId={pageFolderId.get(page.id) ?? null}
                      onSelectPage={onSelectPage}
                      onDeletePage={onDeletePage}
                      onMovePage={handleMovePage}
                      nested
                    />
                  ))}
                </ul>
              )}
              {!folder.collapsed && folderPages.length === 0 && (
                <div className="folder-empty">No pages — click + to add one</div>
              )}
            </li>
          );
        })}

        {unfiledPages.length > 0 && (
          <li className="folder-block unfiled-block">
            {folders.length > 0 && <div className="unfiled-label">Unfiled</div>}
            <ul className="folder-page-list">
              {unfiledPages.map((page) => (
                <PageRow
                  key={page.id}
                  page={page}
                  active={isActivePage(page.id)}
                  folders={folders}
                  folderId={null}
                  onSelectPage={onSelectPage}
                  onDeletePage={onDeletePage}
                  onMovePage={handleMovePage}
                />
              ))}
            </ul>
          </li>
        )}
      </ul>
    </div>
  );
}
