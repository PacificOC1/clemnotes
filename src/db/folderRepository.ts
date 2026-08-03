import { v4 as uuid } from 'uuid';
import { db } from './database';
import type { PageFolder } from './schema';

export async function getAllFolders(): Promise<PageFolder[]> {
  const folders = await db.folders.toArray();
  return folders.sort((a, b) => a.order - b.order);
}

export async function createFolder(name = 'New folder'): Promise<PageFolder> {
  const folders = await getAllFolders();
  const maxOrder = folders.reduce((max, folder) => Math.max(max, folder.order), 0);
  const now = Date.now();
  const folder: PageFolder = {
    id: uuid(),
    name: name.trim() || 'New folder',
    pageIds: [],
    order: maxOrder + 1,
    collapsed: false,
    createdAt: now,
    updatedAt: now,
  };
  await db.folders.add(folder);
  return folder;
}

export async function updateFolderName(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await db.folders.update(id, { name: trimmed, updatedAt: Date.now() });
}

export async function toggleFolderCollapsed(id: string): Promise<void> {
  const folder = await db.folders.get(id);
  if (!folder) return;
  await db.folders.update(id, { collapsed: !folder.collapsed, updatedAt: Date.now() });
}

export async function deleteFolder(id: string): Promise<void> {
  await db.folders.delete(id);
}

export async function addPageToFolder(pageId: string, folderId: string): Promise<void> {
  await movePageToFolder(pageId, folderId);
}

export async function movePageToFolder(pageId: string, folderId: string | null): Promise<void> {
  const folders = await getAllFolders();
  await db.transaction('rw', db.folders, async () => {
    for (const folder of folders) {
      if (!folder.pageIds.includes(pageId)) continue;
      await db.folders.update(folder.id, {
        pageIds: folder.pageIds.filter((id) => id !== pageId),
        updatedAt: Date.now(),
      });
    }
    if (folderId) {
      const target = await db.folders.get(folderId);
      if (target && !target.pageIds.includes(pageId)) {
        await db.folders.update(folderId, {
          pageIds: [...target.pageIds, pageId],
          updatedAt: Date.now(),
        });
      }
    }
  });
}

export async function getPageFolderId(pageId: string): Promise<string | null> {
  const folders = await getAllFolders();
  for (const folder of folders) {
    if (folder.pageIds.includes(pageId)) return folder.id;
  }
  return null;
}

export async function removePageFromAllFolders(pageId: string): Promise<void> {
  await movePageToFolder(pageId, null);
}
