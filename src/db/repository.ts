import { v4 as uuid } from 'uuid';
import { db } from './database';
import { createEmptyNode, type OutlinerNode } from './schema';
import { parseDoc, extractWikiLinkTitles, docFromText, type DocNode } from '../tiptap/docUtils';
import { addPageToFolder, removePageFromAllFolders } from './folderRepository';
import { deleteCardsForNode, reconcileCards } from './cardRepository';

/** Gap left between adjacent order keys when appending; halved on every insert between two rows. */
const ORDER_STEP = 1000;

/** Fetch a single node by id. */
export async function getNode(id: string): Promise<OutlinerNode | undefined> {
  return db.nodes.get(id);
}

/** Fetch all top-level pages, sorted by their order key. */
export async function getAllPages(): Promise<OutlinerNode[]> {
  // Note: IndexedDB doesn't support indexing boolean-valued fields (boolean
  // isn't a valid IndexedDB key type), so a `.where('isPage').equals(...)`
  // index query silently matches nothing — this must scan and filter in
  // memory instead. Fine at this scale (personal notes, not millions of rows).
  const all = await db.nodes.toArray();
  return all.filter((n) => n.isPage && !n.deletedAt).sort((a, b) => a.order - b.order);
}

/** Fetch a node's direct children, sorted by their order key. */
export async function getChildren(parentId: string): Promise<OutlinerNode[]> {
  const children = await db.nodes.where('parentId').equals(parentId).toArray();
  return children.filter((n) => !n.deletedAt).sort((a, b) => a.order - b.order);
}

/** Every non-deleted node in the database — used for link resolution/search. */
export async function getAllNodes(): Promise<OutlinerNode[]> {
  const all = await db.nodes.toArray();
  return all.filter((n) => !n.deletedAt);
}

/** A node's siblings in display order — its parent's children, or the page list at the top level. */
async function getSiblings(node: OutlinerNode): Promise<OutlinerNode[]> {
  return node.parentId ? getChildren(node.parentId) : getAllPages();
}

/** An order key that sits between two rows, or just past the end when there's no `next`. */
function orderBetween(prev: OutlinerNode | undefined, next: OutlinerNode | undefined): number {
  if (prev && next) return (prev.order + next.order) / 2;
  if (prev) return prev.order + ORDER_STEP;
  if (next) return next.order - ORDER_STEP;
  return Date.now();
}

/**
 * Resolve [[Title]] wikiLink nodes in a node's rich-text doc to actual node
 * IDs and persist them as `outboundLinks`. Titles that don't match any
 * existing node are ignored here (the WikiLink NodeView itself offers to
 * create a new page on click if one doesn't exist yet). Can resolve to
 * ANY node, not just top-level pages — a link can point at a single
 * bullet buried deep in another page.
 */
export async function syncOutboundLinks(nodeId: string, doc: DocNode): Promise<void> {
  const titles = extractWikiLinkTitles(doc);
  if (titles.length === 0) {
    const current = await db.nodes.get(nodeId);
    // Skip the write when there's nothing to clear — this runs on every
    // keystroke-debounce, and most rems have no links at all.
    if (current && current.outboundLinks.length === 0) return;
    await db.nodes.update(nodeId, { outboundLinks: [], updatedAt: Date.now() });
    return;
  }

  const allNodes = await getAllNodes();
  const byTitle = new Map<string, string>();
  for (const candidate of allNodes) {
    const key = candidate.plainText.trim().toLowerCase();
    if (key && !byTitle.has(key)) byTitle.set(key, candidate.id);
  }

  const linkedIds = titles
    .map((title) => byTitle.get(title.trim().toLowerCase()))
    .filter((id): id is string => Boolean(id) && id !== nodeId);

  await db.nodes.update(nodeId, { outboundLinks: [...new Set(linkedIds)], updatedAt: Date.now() });
}

/** All nodes that link to `nodeId` via [[...]] — uses the multiEntry index, so this is fast. */
export async function getBacklinks(nodeId: string): Promise<OutlinerNode[]> {
  const rows = await db.nodes.where('outboundLinks').equals(nodeId).toArray();
  return rows.filter((n) => !n.deletedAt);
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

/** True when `candidateId` sits anywhere inside `ancestorId`'s subtree (or is that node). */
export async function isSelfOrDescendant(candidateId: string, ancestorId: string): Promise<boolean> {
  let current = await getNode(candidateId);
  while (current) {
    if (current.id === ancestorId) return true;
    if (!current.parentId) return false;
    current = await getNode(current.parentId);
  }
  return false;
}

/**
 * Create a new page (top-level node) together with its first empty bullet.
 * A page therefore opens with a title and an immediately editable note slot.
 */
export async function createPage(title = 'Untitled', folderId?: string | null): Promise<OutlinerNode> {
  const pages = await getAllPages();
  const lastPage = pages[pages.length - 1];

  const node: OutlinerNode = {
    id: uuid(),
    ...createEmptyNode({
      content: JSON.stringify(docFromText(title)),
      plainText: title,
      isPage: true,
      parentId: null,
      order: lastPage ? lastPage.order + ORDER_STEP : Date.now(),
    }),
  };
  const firstChild: OutlinerNode = {
    id: uuid(),
    ...createEmptyNode({ parentId: node.id, order: Date.now() }),
  };
  node.childrenIds = [firstChild.id];

  await db.transaction('rw', db.nodes, async () => {
    await db.nodes.bulkAdd([node, firstChild]);
  });
  if (folderId) {
    await addPageToFolder(node.id, folderId);
  }
  return node;
}

/**
 * Add the ready-to-type first bullet for pages that were created before this
 * behaviour existed. The transaction makes this safe under React StrictMode.
 */
export async function ensureFirstChild(parentId: string): Promise<OutlinerNode | undefined> {
  return db.transaction('rw', db.nodes, async () => {
    const parent = await db.nodes.get(parentId);
    if (!parent || parent.deletedAt) return undefined;

    const existingChildren = (await db.nodes.where('parentId').equals(parentId).toArray()).filter(
      (child) => !child.deletedAt
    );
    if (existingChildren.length > 0) return existingChildren[0];

    const child: OutlinerNode = {
      id: uuid(),
      ...createEmptyNode({ parentId, order: Date.now() }),
    };
    await db.nodes.add(child);
    await db.nodes.update(parentId, {
      childrenIds: [...parent.childrenIds, child.id],
      collapsed: false,
      updatedAt: Date.now(),
    });
    return child;
  });
}

/**
 * Create a new sibling node right after `afterNodeId` under the same parent.
 * Used when the user presses Enter at the end of a row.
 */
export async function createSiblingAfter(afterNodeId: string): Promise<OutlinerNode> {
  const after = await getNode(afterNodeId);
  if (!after) throw new Error(`Node ${afterNodeId} not found`);

  const siblings = await getSiblings(after);
  const idx = siblings.findIndex((s) => s.id === afterNodeId);
  const order = orderBetween(after, siblings[idx + 1]);

  const node: OutlinerNode = {
    id: uuid(),
    ...createEmptyNode({ parentId: after.parentId, order, isPage: after.isPage && after.parentId === null }),
  };
  await db.nodes.add(node);

  if (after.parentId) {
    const parent = await getNode(after.parentId);
    if (parent) {
      // Insert into childrenIds at the matching position rather than
      // appending, so the array stays a faithful mirror of display order.
      const childrenIds = [...parent.childrenIds];
      const at = childrenIds.indexOf(afterNodeId);
      childrenIds.splice(at === -1 ? childrenIds.length : at + 1, 0, node.id);
      await db.nodes.update(parent.id, { childrenIds, updatedAt: Date.now() });
    }
  }

  return node;
}

/** Create the first child of a node (used when Tab-indenting into an empty parent). */
export async function createFirstChild(parentId: string): Promise<OutlinerNode> {
  const parent = await getNode(parentId);
  if (!parent) throw new Error(`Node ${parentId} not found`);

  const children = await getChildren(parentId);
  const last = children[children.length - 1];

  const node: OutlinerNode = {
    id: uuid(),
    ...createEmptyNode({ parentId, order: last ? last.order + ORDER_STEP : Date.now() }),
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
 *
 * Returns null when the embed would nest a rem inside itself: the embed picker
 * happily offers the very page you're standing on, and embedding it there makes
 * the renderer walk target → subtree → portal → target forever. The renderer
 * has its own guard for cycles that only exist between portals (A embeds B, B
 * embeds A), which can't be seen from the parent tree alone; this one keeps the
 * common accident out of the database in the first place.
 */
export async function createPortalChild(
  parentId: string,
  targetNodeId: string
): Promise<OutlinerNode | null> {
  const parent = await getNode(parentId);
  if (!parent) throw new Error(`Node ${parentId} not found`);

  if (await isSelfOrDescendant(parentId, targetNodeId)) return null;

  const children = await getChildren(parentId);
  const last = children[children.length - 1];

  const node: OutlinerNode = {
    id: uuid(),
    ...createEmptyNode({
      parentId,
      order: last ? last.order + ORDER_STEP : Date.now(),
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

/**
 * Update a node's rich-text content. `docJson` is `JSON.stringify(editor.getJSON())`;
 * `plainText` should be the editor's plain-text rendering. Debounce calls to
 * this from the UI layer. Link resolution and flashcard reconciliation both
 * hang off this single write path.
 */
export async function updateContent(id: string, docJson: string, plainText: string): Promise<void> {
  await db.nodes.update(id, { content: docJson, plainText, updatedAt: Date.now() });
  const doc = parseDoc(docJson);
  await syncOutboundLinks(id, doc);
  const node = await getNode(id);
  if (node) await reconcileCards(node);
}

/** Search node text for wikiLink resolution / omnibar search. Empty query returns a handful of pages as defaults. */
export async function searchNodesByTitle(query: string): Promise<OutlinerNode[]> {
  const q = query.trim().toLowerCase();
  if (!q) {
    const pages = await getAllPages();
    return pages.slice(0, 8);
  }
  const all = await getAllNodes();
  return all
    .filter((n) => n.plainText.trim().length > 0 && n.plainText.toLowerCase().includes(q))
    .sort((a, b) => {
      // Prefer exact matches, then titles that start with the query, then pages.
      const aText = a.plainText.trim().toLowerCase();
      const bText = b.plainText.trim().toLowerCase();
      const score = (text: string, isPage: boolean) =>
        (text === q ? 0 : text.startsWith(q) ? 1 : 2) - (isPage ? 0.5 : 0);
      return score(aText, a.isPage) - score(bText, b.isPage);
    })
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

  const siblings = await getSiblings(node);
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

  const newSiblings = await getChildren(prevSibling.id);
  const last = newSiblings[newSiblings.length - 1];

  await db.nodes.update(prevSibling.id, {
    childrenIds: [...prevSibling.childrenIds.filter((cid) => cid !== id), id],
    collapsed: false,
    updatedAt: Date.now(),
  });

  await db.nodes.update(id, {
    parentId: prevSibling.id,
    order: last ? last.order + ORDER_STEP : Date.now(),
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

  await db.nodes.update(parent.id, {
    childrenIds: parent.childrenIds.filter((cid) => cid !== id),
    updatedAt: Date.now(),
  });

  const grandparentId = parent.parentId;
  const parentSiblings = await getSiblings(parent);
  const parentIdx = parentSiblings.findIndex((s) => s.id === parent.id);
  const newOrder = orderBetween(parent, parentSiblings[parentIdx + 1]);

  if (grandparentId) {
    const grandparent = await getNode(grandparentId);
    if (grandparent) {
      const childrenIds = [...grandparent.childrenIds];
      const at = childrenIds.indexOf(parent.id);
      childrenIds.splice(at === -1 ? childrenIds.length : at + 1, 0, id);
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

/**
 * Move a node one slot up or down among its siblings (Alt+↑ / Alt+↓).
 * Implemented as an order-key swap so nothing else in the tree has to move.
 */
export async function moveAmongSiblings(id: string, delta: number): Promise<boolean> {
  const node = await getNode(id);
  if (!node) return false;

  const siblings = await getSiblings(node);
  const idx = siblings.findIndex((s) => s.id === id);
  const target = siblings[idx + delta];
  if (idx === -1 || !target) return false;

  const now = Date.now();
  await db.nodes.update(node.id, { order: target.order, updatedAt: now });
  await db.nodes.update(target.id, { order: node.order, updatedAt: now });

  // Keep the parent's childrenIds mirror in step with the new display order.
  if (node.parentId) {
    const parent = await getNode(node.parentId);
    if (parent) {
      const childrenIds = [...parent.childrenIds];
      const from = childrenIds.indexOf(id);
      const to = childrenIds.indexOf(target.id);
      if (from !== -1 && to !== -1) {
        childrenIds[from] = target.id;
        childrenIds[to] = id;
        await db.nodes.update(parent.id, { childrenIds, updatedAt: now });
      }
    }
  }

  return true;
}

export type DropPosition = 'before' | 'after' | 'child';

/**
 * Move a node next to (or inside) another node — the drag-and-drop path.
 * Refuses to drop a node into its own subtree, which would detach that whole
 * branch from the tree with no way back to it.
 */
export async function moveNodeRelativeTo(
  id: string,
  targetId: string,
  position: DropPosition
): Promise<boolean> {
  if (id === targetId) return false;

  const node = await getNode(id);
  const target = await getNode(targetId);
  if (!node || !target) return false;
  if (await isSelfOrDescendant(targetId, id)) return false;

  const newParentId = position === 'child' ? target.id : target.parentId;
  let order: number;

  if (position === 'child') {
    const children = (await getChildren(target.id)).filter((c) => c.id !== id);
    const last = children[children.length - 1];
    order = last ? last.order + ORDER_STEP : Date.now();
  } else {
    const siblings = (await getSiblings(target)).filter((s) => s.id !== id);
    const targetIdx = siblings.findIndex((s) => s.id === targetId);
    order =
      position === 'before'
        ? orderBetween(siblings[targetIdx - 1], target)
        : orderBetween(target, siblings[targetIdx + 1]);
  }

  const now = Date.now();

  // Detach from the old parent.
  if (node.parentId && node.parentId !== newParentId) {
    const oldParent = await getNode(node.parentId);
    if (oldParent) {
      await db.nodes.update(oldParent.id, {
        childrenIds: oldParent.childrenIds.filter((cid) => cid !== id),
        updatedAt: now,
      });
    }
  }

  // Attach to the new one.
  if (newParentId) {
    const parent = await getNode(newParentId);
    if (parent) {
      const childrenIds = parent.childrenIds.filter((cid) => cid !== id);
      if (position === 'child') {
        childrenIds.push(id);
      } else {
        const at = childrenIds.indexOf(targetId);
        childrenIds.splice(at === -1 ? childrenIds.length : position === 'before' ? at : at + 1, 0, id);
      }
      await db.nodes.update(parent.id, { childrenIds, collapsed: false, updatedAt: now });
    }
  }

  await db.nodes.update(id, {
    parentId: newParentId,
    order,
    isPage: newParentId === null,
    updatedAt: now,
  });

  return true;
}

/**
 * Soft-delete a node and (recursively) all of its descendants — sets
 * `deletedAt` rather than physically removing the row, so cloud sync can
 * propagate the deletion instead of silently re-downloading the node from
 * another device that hasn't seen the delete yet.
 */
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

  const now = Date.now();
  if (node.isPage && node.parentId === null) {
    await removePageFromAllFolders(id);
  }
  await deleteCardsForNode(id);
  await db.nodes.update(id, { deletedAt: now, updatedAt: now });
}

/**
 * Merge a node into its previous sibling (used on Backspace at position 0).
 * Note: this concatenates plain text rather than merging rich-text docs
 * structurally, so inline formatting/links on the merged-in node are not
 * preserved — a reasonable tradeoff since merges are relatively rare
 * and usually happen on near-empty rows.
 */
export async function mergeWithPreviousSibling(id: string): Promise<string | null> {
  const node = await getNode(id);
  if (!node || !node.parentId) return null;

  const siblings = await getChildren(node.parentId);
  const idx = siblings.findIndex((s) => s.id === id);
  const prevSibling = siblings[idx - 1];
  if (!prevSibling) return null;

  const mergedText = prevSibling.plainText + node.plainText;
  const mergedDoc = JSON.stringify(docFromText(mergedText));
  await db.nodes.update(prevSibling.id, { content: mergedDoc, plainText: mergedText, updatedAt: Date.now() });

  // Re-parent node's children onto prevSibling
  for (const childId of node.childrenIds) {
    await db.nodes.update(childId, { parentId: prevSibling.id, updatedAt: Date.now() });
  }
  await db.nodes.update(prevSibling.id, {
    childrenIds: [...prevSibling.childrenIds, ...node.childrenIds],
  });
  // Clear the merged-away node's own childrenIds first — otherwise
  // deleteNode's recursive cascade would wrongly soft-delete the children
  // we just re-parented onto prevSibling above.
  await db.nodes.update(id, { childrenIds: [] });

  await deleteNode(id);

  const merged = await getNode(prevSibling.id);
  if (merged) await reconcileCards(merged);

  return prevSibling.id;
}
