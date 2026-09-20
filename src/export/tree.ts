import { db } from '../db/database';
import type { OutlinerNode } from '../db/schema';
import type { ExportTreeNode } from './markdown';

/**
 * Build the page trees the Markdown exporter walks.
 *
 * Everything is assembled from one full read of the nodes table rather than a
 * query per rem: an export touches every rem by definition, so one scan is
 * both cheaper and — more importantly — a consistent snapshot. Walking the
 * tree with a query per level would let a sync pull land mid-export and
 * produce a file that never existed as a state of the database.
 */
export async function buildExportTrees(pageIds?: string[]): Promise<ExportTreeNode[]> {
  return buildTrees((live) =>
    live
      .filter((n) => n.parentId === null && n.isPage)
      .sort((a, b) => a.order - b.order)
      .filter((p) => !pageIds || pageIds.includes(p.id))
  );
}

/**
 * The same walk, rooted at an arbitrary set of rems rather than at the pages —
 * what "copy as Markdown" needs, since a selection is a handful of rows
 * somewhere in the middle of a document.
 *
 * Roots are returned in the order given, so a selection copies out in the
 * order it was made rather than in table order.
 */
export async function buildSubtrees(rootIds: string[]): Promise<ExportTreeNode[]> {
  return buildTrees((live) => {
    const byId = new Map(live.map((n) => [n.id, n]));
    return rootIds
      .map((id) => byId.get(id))
      .filter((n): n is OutlinerNode => n !== undefined);
  });
}

async function buildTrees(
  pickRoots: (live: OutlinerNode[]) => OutlinerNode[]
): Promise<ExportTreeNode[]> {
  const all = await db.nodes.toArray();
  const live = all.filter((n) => n.deletedAt === null);

  const byId = new Map(live.map((n) => [n.id, n]));
  const childrenOf = new Map<string, OutlinerNode[]>();
  for (const node of live) {
    if (node.parentId === null) continue;
    const siblings = childrenOf.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parentId, [node]);
  }
  for (const siblings of childrenOf.values()) siblings.sort((a, b) => a.order - b.order);

  // A cycle can only come from corrupted data, but an exporter that hangs on
  // it is no use as a recovery tool — which is exactly when you'd reach for it.
  function build(node: OutlinerNode, seen: Set<string>): ExportTreeNode {
    if (seen.has(node.id)) return { node, children: [] };
    const nextSeen = new Set(seen).add(node.id);
    const entry: ExportTreeNode = {
      node,
      children: (childrenOf.get(node.id) ?? []).map((child) => build(child, nextSeen)),
    };
    if (node.isPortal && node.portalTargetId) {
      const target = byId.get(node.portalTargetId);
      entry.portalTitle = target?.plainText.trim() || 'deleted rem';
    }
    return entry;
  }

  return pickRoots(live).map((root) => build(root, new Set()));
}
