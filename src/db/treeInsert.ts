import { v4 as uuid } from 'uuid';
import { db } from './database';
import { createEmptyNode, type OutlinerNode } from './schema';
import { getChildren, getAllNodes, getAllPages } from './repository';
import { addPageToFolder } from './folderRepository';
import { reconcileCards } from './cardRepository';
import { indexNode } from './searchIndex';
import { noteCreated, pushUndo, takeSnapshot } from './undo';
import { docToPlainText, extractReferences, parseDoc, renumberClozesInDoc, type DocNode } from '../tiptap/docUtils';

/**
 * Putting a whole tree of new rems into the notebook at once — a template
 * being stamped out, or a file being imported.
 *
 * Going through `createSiblingAfter` + `updateContent` one rem at a time would
 * work, and would cost a full-table link lookup per rem with a hand-typed link
 * in it, an undo entry per rem, and a search-index patch per keystroke that
 * never happened. Here the whole tree is built in memory, links are resolved
 * against one title map, the rows go in one transaction, and the lot is one
 * undo.
 */

export interface DraftRem {
  /** Set by a caller that needs to find the rem again afterwards (the Anki importer does). */
  id?: string;
  doc: DocNode;
  children?: DraftRem[];
  collapsed?: boolean;
  /** An embed of an existing rem, rather than text of its own. */
  portalTargetId?: string | null;
  cardDirection?: OutlinerNode['cardDirection'];
}

const ORDER_STEP = 1000;

interface Built {
  rows: OutlinerNode[];
  topIds: string[];
}

function build(drafts: DraftRem[], parentId: string | null, orders: number[], now: number): Built {
  const rows: OutlinerNode[] = [];
  const topIds: string[] = [];

  function add(draft: DraftRem, parent: string | null, order: number): string {
    const doc = renumberClozesInDoc(draft.doc) ?? draft.doc;
    const id = draft.id ?? uuid();
    const row: OutlinerNode = {
      id,
      ...createEmptyNode({
        content: JSON.stringify(doc),
        plainText: docToPlainText(doc),
        parentId: parent,
        order,
        collapsed: draft.collapsed ?? false,
        isPortal: Boolean(draft.portalTargetId),
        portalTargetId: draft.portalTargetId ?? null,
        cardDirection: draft.cardDirection ?? 'forward',
        createdAt: now,
        updatedAt: now,
      }),
    };
    rows.push(row);
    (draft.children ?? []).forEach((child, i) => add(child, id, now + (i + 1) * ORDER_STEP));
    return id;
  }

  drafts.forEach((draft, i) => topIds.push(add(draft, parentId, orders[i]!)));
  return { rows, topIds };
}

/**
 * Resolve every link and tag in the new rows against one title map built from
 * the notebook plus the new rows themselves — so a file that links to a page
 * imported alongside it resolves too.
 */
async function resolveReferences(rows: OutlinerNode[]): Promise<void> {
  const byTitle = new Map<string, string>();
  const existing = await getAllNodes();
  for (const node of [...existing, ...rows]) {
    const key = node.plainText.trim().toLowerCase();
    // Pages first: a title is far more likely to mean the page than a bullet
    // that happens to read the same.
    if (key && (!byTitle.has(key) || node.isPage)) byTitle.set(key, node.id);
  }
  const known = new Set([...existing.map((n) => n.id), ...rows.map((n) => n.id)]);
  for (const row of rows) {
    const refs = extractReferences(parseDoc(row.content));
    const ids = refs
      .map((ref) => (ref.targetId && known.has(ref.targetId) ? ref.targetId : byTitle.get(ref.title.trim().toLowerCase())))
      .filter((id): id is string => Boolean(id) && id !== row.id);
    row.outboundLinks = [...new Set(ids)];
  }
}

async function finish(rows: OutlinerNode[]): Promise<void> {
  for (const row of rows) {
    await reconcileCards(row);
    indexNode(row);
  }
}

export interface Inserted {
  /** The new top-level rems, in order. */
  topIds: string[];
  /** Every rem created, children included — what an enclosing undo must note. */
  ids: string[];
}

/**
 * Insert `drafts` as siblings right after `afterId` (under its parent), or as
 * the last children of `parentId`.
 */
export async function insertTree(
  drafts: DraftRem[],
  place: { afterId: string } | { parentId: string },
  label = 'Insert'
): Promise<Inserted> {
  if (drafts.length === 0) return { topIds: [], ids: [] };
  const now = Date.now();

  let parentId: string | null;
  let orders: number[];
  if ('afterId' in place) {
    const after = await db.nodes.get(place.afterId);
    if (!after) return { topIds: [], ids: [] };
    parentId = after.parentId;
    const siblings = parentId ? await getChildren(parentId) : [];
    const next = siblings[siblings.findIndex((s) => s.id === after.id) + 1];
    const gap = next ? (next.order - after.order) / (drafts.length + 1) : ORDER_STEP;
    orders = drafts.map((_, i) => after.order + gap * (i + 1));
  } else {
    parentId = place.parentId;
    const siblings = await getChildren(parentId);
    const last = siblings[siblings.length - 1]?.order ?? now;
    orders = drafts.map((_, i) => last + ORDER_STEP * (i + 1));
  }

  const { rows, topIds } = build(drafts, parentId, orders, now);
  await resolveReferences(rows);

  const entry = await takeSnapshot(label, [parentId]);
  await db.transaction('rw', db.nodes, async () => {
    await db.nodes.bulkAdd(rows);
    if (parentId) {
      // Unfold the parent so what went in is visible; folding isn't an edit.
      const parent = await db.nodes.get(parentId);
      if (parent?.collapsed) await db.nodes.update(parentId, { collapsed: false });
    }
  });
  noteCreated(entry, rows.map((r) => r.id));
  pushUndo(entry);

  await finish(rows);
  return { topIds, ids: rows.map((r) => r.id) };
}

export interface DraftPage {
  title: DocNode;
  drafts: DraftRem[];
  folderId?: string | null;
}

/**
 * New pages, each holding its drafts, resolved against each other in one pass
 * — so an imported folder of files that link to one another comes in linked.
 * Returns the page ids, in order.
 */
export async function createPagesWithTrees(pagesIn: DraftPage[]): Promise<string[]> {
  if (pagesIn.length === 0) return [];
  const now = Date.now();
  const existingPages = await getAllPages();
  let order = existingPages.reduce((max, p) => Math.max(max, p.order), 0);

  const all: OutlinerNode[] = [];
  const pageIds: string[] = [];
  for (const draftPage of pagesIn) {
    order += ORDER_STEP;
    const [page] = build([{ doc: draftPage.title }], null, [order], now).rows;
    page!.isPage = true;
    const body = draftPage.drafts.length > 0 ? draftPage.drafts : [{ doc: { type: 'doc', content: [{ type: 'paragraph' }] } }];
    const { rows } = build(body, page!.id, body.map((_, i) => now + (i + 1) * ORDER_STEP), now);
    all.push(page!, ...rows);
    pageIds.push(page!.id);
  }

  await resolveReferences(all);
  await db.nodes.bulkAdd(all);
  for (let i = 0; i < pagesIn.length; i++) {
    const folderId = pagesIn[i]!.folderId;
    if (folderId) await addPageToFolder(pageIds[i]!, folderId);
  }
  await finish(all);
  return pageIds;
}

/** A new page titled `title` holding `drafts`, optionally filed in a folder. Returns its id. */
export async function createPageWithTree(title: DocNode, drafts: DraftRem[], folderId: string | null = null): Promise<string> {
  const [id] = await createPagesWithTrees([{ title, drafts, folderId }]);
  return id!;
}

/** A rem's subtree as drafts — the other half of copying it somewhere else. */
export async function subtreeAsDrafts(parentId: string): Promise<DraftRem[]> {
  const children = await getChildren(parentId);
  return Promise.all(
    children.map(async (child) => ({
      doc: parseDoc(child.content),
      collapsed: child.collapsed,
      portalTargetId: child.isPortal ? child.portalTargetId : null,
      cardDirection: child.cardDirection,
      children: await subtreeAsDrafts(child.id),
    }))
  );
}
