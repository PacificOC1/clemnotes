import { db } from './database';
import { getChildren } from './repository';
import { parseDoc, docToPlainText } from '../tiptap/docUtils';
import type { OutlinerNode } from './schema';

/**
 * Whole-document views over a subtree: how long it is, and what its headings
 * are (#45).
 */

/**
 * Every live rem under `rootId`, root included, level by level — one indexed
 * query per level rather than one per rem, which is what lets the word count
 * stay live on a long page. Portals are counted as themselves (nothing), not
 * as the rem they embed: that text belongs to another document.
 */
export async function subtreeRows(rootId: string): Promise<OutlinerNode[]> {
  const root = await db.nodes.get(rootId);
  if (!root || root.deletedAt) return [];
  const out: OutlinerNode[] = [root];
  const seen = new Set([rootId]);
  let level = [rootId];
  while (level.length > 0) {
    const children = (await db.nodes.where('parentId').anyOf(level).toArray()).filter(
      (n) => !n.deletedAt && !seen.has(n.id)
    );
    for (const child of children) seen.add(child.id);
    out.push(...children);
    level = children.map((c) => c.id);
  }
  return out;
}

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

export function countWordsIn(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/** Words in a rem and everything under it. */
export async function countWords(rootId: string): Promise<number> {
  const rows = await subtreeRows(rootId);
  return rows.reduce((sum, row) => sum + countWordsIn(row.plainText), 0);
}

export interface TocEntry {
  id: string;
  level: number;
  text: string;
}

/**
 * The rems under `rootId` that open with a heading, in reading order, with
 * their heading level — collapsed branches included, because a table of
 * contents that forgets the parts you folded away isn't one.
 */
export async function tableOfContents(rootId: string): Promise<TocEntry[]> {
  const out: TocEntry[] = [];
  const seen = new Set<string>();
  async function walk(id: string) {
    for (const child of await getChildren(id)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      const first = parseDoc(child.content).content?.[0];
      if (first?.type === 'heading') {
        const text = docToPlainText({ type: 'doc', content: [first] });
        if (text) out.push({ id: child.id, level: Number(first.attrs?.level ?? 1), text });
      }
      if (!child.isPortal) await walk(child.id);
    }
  }
  await walk(rootId);
  return out;
}
