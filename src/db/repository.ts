import { v4 as uuid } from 'uuid';
import { db } from './database';
import { createEmptyNode, type OutlinerNode } from './schema';

/** Fetch a single node by id. */
export async function getNode(id: string): Promise<OutlinerNode | undefined> {
  return db.nodes.get(id);
}

/** Fetch all top-level pages, sorted by creation time (newest first). */
export async function getAllPages(): Promise<OutlinerNode[]> {
  const pages = await db.nodes.where('isPage').equals(1 as unknown as number).toArray();
  // Dexie stores booleans fine but the boolean index query above is a common
  // gotcha - filter defensively as well:
  return pages.filter((n) => n.isPage).sort((a, b) => b.createdAt - a.createdAt);
}

/** Fetch a node's direct children, sorted by their order key. */
export async function getChildren(parentId: string): Promise<OutlinerNode[]> {
  const children = await db.nodes.where('parentId').equals(parentId).toArray();
  return children.sort((a, b) => a.order - b.order);
}

/** Create a new page (top-level node). */
export async function createPage(content = 'Untitled'): Promise<OutlinerNode> {
  const node: OutlinerNode = {
    id: uuid(),
    ...createEmptyNode({ content, isPage: true, parentId: null }),
  };
  await db.nodes.add(node);
  return node;
}

/**
 * Create a new sibling node right after `afterNodeId` under the same parent.
 * Used when the user presses Enter at the end of a row.
 */
export async function createSiblingAfter(afterNodeId: string): Promise<OutlinerNode> {
  const after = await getNode(afterNodeId);
  if (!after) throw new Error(`Node ${afterNodeId} not found`);

  const siblings = after.parentId
    ? await getChildren(after.parentId)
    : await getAllPages();

  const idx = siblings.findIndex((s) => s.id === afterNodeId);
  const nextSibling = siblings[idx + 1];
  const order = nextSibling ? (after.order + nextSibling.order) / 2 : after.order + 1000;

  const node: OutlinerNode = {
    id: uuid(),
    ...createEmptyNode({ parentId: after.parentId, order, isPage: after.isPage && after.parentId === null }),
  };
  await db.nodes.add(node);

  if (after.parentId) {
    const parent = await getNode(after.parentId);
    if (parent) {
      const childrenIds = [...parent.childrenIds, node.id];
      await db.nodes.update(parent.id, { childrenIds, updatedAt: Date.now() });
    }
  }

  return node;
}

/** Create the first child of a node (used when Tab-indenting into an empty parent). */
export async function createFirstChild(parentId: string): Promise<OutlinerNode> {
  const parent = await getNode(parentId);
  if (!parent) throw new Error(`Node ${parentId} not found`);

  const node: OutlinerNode = {
    id: uuid(),
    ...createEmptyNode({ parentId, order: Date.now() }),
  };
  await db.nodes.add(node);

  await db.nodes.update(parentId, {
    childrenIds: [...parent.childrenIds, node.id],
    collapsed: false,
    updatedAt: Date.now(),
  });

  return node;
}

/** Update a node's text content. Debounce calls to this from the UI layer. */
export async function updateContent(id: string, content: string): Promise<void> {
  await db.nodes.update(id, { content, updatedAt: Date.now() });
}

/** Toggle collapsed/expanded state. */
export async function toggleCollapsed(id: string): Promise<void> {
  const node = await getNode(id);
  if (!node) return;
  await db.nodes.update(id, { collapsed: !node.collapsed });
}

/**
 * Indent a node: make it the last child of its previous sibling.
 * Returns false if there's no previous sibling (can't indent the first child).
 */
export async function indentNode(id: string): Promise<boolean> {
  const node = await getNode(id);
  if (!node) return false;

  const siblings = node.parentId ? await getChildren(node.parentId) : await getAllPages();
  const idx = siblings.findIndex((s) => s.id === id);
  const prevSibling = siblings[idx - 1];
  if (!prevSibling) return false;

  // Remove from old parent's childrenIds
  if (node.parentId) {
    const oldParent = await getNode(node.parentId);
    if (oldParent) {
      await db.nodes.update(oldParent.id, {
        childrenIds: oldParent.childrenIds.filter((cid) => cid !== id),
        updatedAt: Date.now(),
      });
    }
  }

  // Append as last child of prevSibling
  const newOrder = prevSibling.childrenIds.length
    ? Date.now() // simplification: append at end with a fresh timestamp order key
    : Date.now();

  await db.nodes.update(prevSibling.id, {
    childrenIds: [...prevSibling.childrenIds, id],
    collapsed: false,
    updatedAt: Date.now(),
  });

  await db.nodes.update(id, {
    parentId: prevSibling.id,
    order: newOrder,
    isPage: false,
    updatedAt: Date.now(),
  });

  return true;
}

/**
 * Outdent a node: move it to be a sibling of its current parent, positioned
 * right after the parent. Returns false if the node has no parent (already top-level).
 */
export async function outdentNode(id: string): Promise<boolean> {
  const node = await getNode(id);
  if (!node || !node.parentId) return false;

  const parent = await getNode(node.parentId);
  if (!parent) return false;

  // Remove from parent's childrenIds
  await db.nodes.update(parent.id, {
    childrenIds: parent.childrenIds.filter((cid) => cid !== id),
    updatedAt: Date.now(),
  });

  const grandparentId = parent.parentId;
  const newOrder = parent.order + 0.5; // place right after the old parent

  if (grandparentId) {
    const grandparent = await getNode(grandparentId);
    if (grandparent) {
      const parentIdx = grandparent.childrenIds.indexOf(parent.id);
      const childrenIds = [...grandparent.childrenIds];
      childrenIds.splice(parentIdx + 1, 0, id);
      await db.nodes.update(grandparent.id, { childrenIds, updatedAt: Date.now() });
    }
  }

  await db.nodes.update(id, {
    parentId: grandparentId,
    order: newOrder,
    isPage: grandparentId === null,
    updatedAt: Date.now(),
  });

  return true;
}

/** Delete a node and (recursively) all of its descendants. */
export async function deleteNode(id: string): Promise<void> {
  const node = await getNode(id);
  if (!node) return;

  for (const childId of node.childrenIds) {
    await deleteNode(childId);
  }

  if (node.parentId) {
    const parent = await getNode(node.parentId);
    if (parent) {
      await db.nodes.update(parent.id, {
        childrenIds: parent.childrenIds.filter((cid) => cid !== id),
        updatedAt: Date.now(),
      });
    }
  }

  await db.nodes.delete(id);
}

/** Merge a node into its previous sibling (used on Backspace at position 0). */
export async function mergeWithPreviousSibling(id: string): Promise<string | null> {
  const node = await getNode(id);
  if (!node || !node.parentId) return null;

  const siblings = await getChildren(node.parentId);
  const idx = siblings.findIndex((s) => s.id === id);
  const prevSibling = siblings[idx - 1];
  if (!prevSibling) return null;

  const mergedContent = prevSibling.content + node.content;
  await db.nodes.update(prevSibling.id, { content: mergedContent, updatedAt: Date.now() });

  // Re-parent node's children onto prevSibling
  for (const childId of node.childrenIds) {
    await db.nodes.update(childId, { parentId: prevSibling.id, updatedAt: Date.now() });
  }
  await db.nodes.update(prevSibling.id, {
    childrenIds: [...prevSibling.childrenIds, ...node.childrenIds],
  });

  await deleteNode(id);
  return prevSibling.id;
}
