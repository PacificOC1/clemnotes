import { db } from './database';
import { findRootPage, isSelfOrDescendant, updateContent } from './repository';
import { searchNodes } from './searchIndex';
import { docToPlainText, linkFirstMention, mentionPattern, parseDoc } from '../tiptap/docUtils';
import type { OutlinerNode } from './schema';

/**
 * Unlinked references: rems that mention this one by name without linking to
 * it. The cheap version of a knowledge graph — no model, just the notebook's
 * own words — and usually the moment you notice two notes are about the same
 * thing.
 */

/** Titles shorter than this match too much to be useful ("a", "Re"). */
export const MIN_TITLE_LENGTH = 3;

export interface UnlinkedReference {
  node: OutlinerNode;
  sourcePage: OutlinerNode | undefined;
}

export async function getUnlinkedReferences(nodeId: string, limit = 50): Promise<UnlinkedReference[]> {
  const target = await db.nodes.get(nodeId);
  const title = target?.plainText.trim() ?? '';
  if (!target || title.length < MIN_TITLE_LENGTH) return [];

  const pattern = mentionPattern(title);
  const hits = await searchNodes(title, 300);
  const out: UnlinkedReference[] = [];
  for (const { node, sourcePage } of hits) {
    if (out.length >= limit) break;
    if (node.id === nodeId || node.deletedAt || node.isPortal) continue;
    if (node.outboundLinks.includes(nodeId)) continue;
    if (!pattern.test(node.plainText)) continue;
    // A rem inside this one naming it is context, not a reference.
    if (await isSelfOrDescendant(node.id, nodeId)) continue;
    // Nor is a rem whose whole text *is* the title — that's a namesake.
    if (node.plainText.trim().toLowerCase() === title.toLowerCase()) continue;
    // The search index can lag a write; trust the stored row.
    const fresh = await db.nodes.get(node.id);
    if (!fresh || !linkFirstMention(parseDoc(fresh.content), title, nodeId)) continue;
    out.push({ node: fresh, sourcePage: sourcePage ?? (await findRootPage(node.id)) });
  }
  return out;
}

/** Link the first mention of `targetId`'s title in `sourceId`. Returns false if there was none. */
export async function linkMention(sourceId: string, targetId: string): Promise<boolean> {
  const [source, target] = await Promise.all([db.nodes.get(sourceId), db.nodes.get(targetId)]);
  if (!source || !target) return false;
  const linked = linkFirstMention(parseDoc(source.content), target.plainText, targetId);
  if (!linked) return false;
  await updateContent(sourceId, JSON.stringify(linked), docToPlainText(linked));
  return true;
}
