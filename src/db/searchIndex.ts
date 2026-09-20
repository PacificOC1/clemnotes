import { Index } from 'flexsearch';
import { getAllNodes, findRootPage } from './repository';
import type { OutlinerNode } from './schema';

export interface SearchResult {
  node: OutlinerNode;
  sourcePage: OutlinerNode | undefined;
}

/**
 * One FlexSearch index, kept for the life of the tab.
 *
 * It used to be rebuilt from zero every time ⌘K opened — a full table read
 * and a re-tokenise of every rem, on a keypress. Imperceptible at a few
 * hundred rems and a visible stall at a few thousand, which is the shape of
 * problem that arrives exactly when the notebook has become worth searching.
 *
 * Now it is built once, lazily, and kept in step by the write path: every
 * content write calls `indexNode`, every delete calls `removeFromIndex`. The
 * index is a cache of `plainText`, so the worst a missed update can do is a
 * stale result until the tab is reloaded — no data is at risk either way.
 */

interface LiveIndex {
  index: Index;
  nodesById: Map<string, OutlinerNode>;
}

let live: LiveIndex | null = null;
let building: Promise<LiveIndex> | null = null;

function addToIndex(target: LiveIndex, node: OutlinerNode): void {
  const text = node.plainText.trim();
  if (!text || node.deletedAt) {
    // `remove` on an id that was never added is a no-op in FlexSearch, so an
    // empty or deleted rem can be handled the same way as any other update.
    target.index.remove(node.id);
    target.nodesById.delete(node.id);
    return;
  }
  // `update` handles both "new" and "already there", which is what a write
  // path needs — it cannot know which it is without asking.
  target.index.update(node.id, text);
  target.nodesById.set(node.id, node);
}

async function build(): Promise<LiveIndex> {
  const target: LiveIndex = { index: new Index({ tokenize: 'forward' }), nodesById: new Map() };
  for (const node of await getAllNodes()) addToIndex(target, node);
  return target;
}

/** The index, building it the first time it is asked for. */
async function ready(): Promise<LiveIndex> {
  if (live) return live;
  // Two searches opened before the first build finished would otherwise each
  // build their own.
  building ??= build().then((built) => {
    live = built;
    building = null;
    return built;
  });
  return building;
}

/**
 * Keep one rem in step. Called from the write path — cheap enough to run on
 * every debounced content write, and a no-op before the index exists, because
 * the build that happens later will read the row anyway.
 */
export function indexNode(node: OutlinerNode): void {
  if (live) addToIndex(live, node);
}

export function removeFromIndex(nodeIds: string[]): void {
  if (!live) return;
  for (const id of nodeIds) {
    live.index.remove(id);
    live.nodesById.delete(id);
  }
}

/** Throw the index away — after a restore or a sync pull that rewrote rows. */
export function invalidateSearchIndex(): void {
  live = null;
  building = null;
}

export async function searchNodes(term: string, limit = 20): Promise<SearchResult[]> {
  if (!term.trim()) return [];
  const { index, nodesById } = await ready();
  const ids = index.search(term, { limit }) as string[];

  return Promise.all(
    ids
      .map((id) => nodesById.get(id))
      .filter((node): node is OutlinerNode => node !== undefined)
      .map(async (node) => ({ node, sourcePage: await findRootPage(node.id) }))
  );
}

/**
 * Warm the index without searching, so the first ⌘K is instant.
 *
 * Kept separate from `searchNodes` so the caller decides when to pay for it —
 * at startup, in the background, rather than on the keypress.
 */
export async function warmSearchIndex(): Promise<void> {
  await ready();
}
