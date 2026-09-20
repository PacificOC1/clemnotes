import { attachLinkTargets, parseDoc } from '../tiptap/docUtils';
import type { OutlinerNode } from './schema';

/**
 * Give every link written before ids existed the id it always meant.
 *
 * Run once, as the v10 migration. Until a link carries an id it is a text
 * match — so it still resolves, but it breaks the moment its target is
 * renamed, and there is no way to tell two rems with identical text apart.
 * Backfilling turns the whole existing notebook over to ids in one pass
 * instead of leaving the old behaviour lying around for years.
 *
 * Pure, and over plain rows rather than a Dexie transaction, so the thing
 * that rewrites everyone's notes can be tested directly.
 */

/**
 * Title → id, the way link resolution has always done it: first match wins,
 * case- and whitespace-insensitive, tombstones excluded.
 */
export function buildTitleIndex(nodes: OutlinerNode[]): Map<string, string> {
  const byTitle = new Map<string, string>();
  for (const node of nodes) {
    if (node.deletedAt) continue;
    const key = (node.plainText ?? '').trim().toLowerCase();
    if (key && !byTitle.has(key)) byTitle.set(key, node.id);
  }
  return byTitle;
}

/**
 * The rows that need rewriting, with their new `content`. Rows whose links
 * already carry ids, or whose titles resolve to nothing, are left out — a
 * migration that rewrites every row it looked at is a migration that cannot
 * be run twice.
 *
 * `updatedAt` is deliberately *not* bumped. Filling in an id is a
 * representation change, not an edit: touching the timestamp would make every
 * device push its entire notebook on the next sync and fight over which copy
 * of an unchanged note wins.
 */
export function planLinkBackfill(nodes: OutlinerNode[]): OutlinerNode[] {
  const byTitle = buildTitleIndex(nodes);
  const resolve = (title: string) => byTitle.get(title.trim().toLowerCase());

  const updates: OutlinerNode[] = [];
  for (const node of nodes) {
    if (!node.content?.includes('wikiLink')) continue;
    const next = attachLinkTargets(parseDoc(node.content), (title) => {
      const id = resolve(title);
      // A rem linking to itself by title is a no-op, not a link.
      return id === node.id ? undefined : id;
    });
    if (next) updates.push({ ...node, content: JSON.stringify(next) });
  }
  return updates;
}
