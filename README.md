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

/** Matches [[Page Title]] references. */
const LINK_REGEX = /\[\[([^\]]+)\]\]/g;

/** Extract the raw title strings inside [[...]] from a block of text. */
export function extractLinkTitles(content: string): string[] {
  const titles: string[] = [];
  const regex = new RegExp(LINK_REGEX);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    titles.push(match[1].trim());
  }
  return titles;
}

/**
 * Resolve [[Title]] references in a node's content to actual node IDs and
 * persist them as `outboundLinks`. Titles that don't match any existing
 * node are ignored (not auto-created). Can resolve to ANY node, not just
 * top-level pages — enabled by zoom navigation, so a link can point at a
 * single bullet buried deep in another page.
 */
export async function syncOutboundLinks(nodeId: string, content: string): Promise<void> {
  const titles = extractLinkTitles(content);
  if (titles.length === 0) {
    await db.nodes.update(nodeId, { outboundLinks: [], updatedAt: Date.now() });
    return;
  }

  const allNodes = await getAllNodes();
  const linkedIds = titles
    .map((title) =>
      allNodes.find((n) => n.id !== nodeId && n.content.trim().toLowerCase() === title.toLowerCase())
    )
    .filter((n): n is OutlinerNode => Boolean(n))
    .map((n) => n.id);

  // De-duplicate
  await db.nodes.update(nodeId, { outboundLinks: [...new Set(linkedIds)], updatedAt: Date.now() });
}

/** All nodes that link to `nodeId` via [[...]] — uses the multiEntry index, so this is fast. */
export async function getBacklinks(nodeId: string): Promise<OutlinerNode[]> {
  return db.nodes.where('outboundLinks').equals(nodeId).toArray();
}

/** Walk up parentId pointers to find the top-level page a node belongs to. */
export async function findRootPage(nodeId: string): Promise<OutlinerNode | undefined> {
  let current = await getNode(nodeId);
  while (current && current.parentId) {
    current = await getNode(current.parentId);
  }
  return current;
}

/**
 * The full ancestor chain from the root page down to (and including) a
 * node — used to render breadcrumbs when zoomed into any bullet.
 */
export async function getBreadcrumbPath(nodeId: string): Promise<OutlinerNode[]> {
  const path: OutlinerNode[] = [];
  let current = await getNode(nodeId);
  while (current) {
    path.unshift(current);
    if (!current.parentId) break;
    current = await getNode(current.parentId);
  }
  return path;
}

/** Every node in the database — used for link resolution/search. Fine at this scale (no server-side full-text index yet). */
export async function getAllNodes(): Promise<OutlinerNode[]> {
  return db.nodes.toArray();
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

/**
 * Create a portal node — a child of `parentId` that embeds a live,
 * editable view of `targetNodeId`'s subtree rather than holding its own
 * text content.
 */
export async function createPortalChild(parentId: string, targetNodeId: string): Promise<OutlinerNode> {
  const parent = await getNode(parentId);
  if (!parent) throw new Error(`Node ${parentId} not found`);

  const node: OutlinerNode = {
    id: uuid(),
    ...createEmptyNode({
      parentId,
      order: Date.now(),
      isPortal: true,
      portalTargetId: targetNodeId,
    }),
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
  await syncOutboundLinks(id, content);
}

/** Search node text for [[ autocomplete. Empty query returns a handful of pages as defaults. */
export async function searchNodesByTitle(query: string): Promise<OutlinerNode[]> {
  const q = query.trim().toLowerCase();
  if (!q) {
    const pages = await getAllPages();
    return pages.slice(0, 8);
  }
  const all = await getAllNodes();
  return all
    .filter((n) => n.content.trim().length > 0 && n.content.toLowerCase().includes(q))
    .slice(0, 8);
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
