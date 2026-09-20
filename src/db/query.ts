import { db } from './database';
import { findRootPage } from './repository';
import { searchNodes } from './searchIndex';
import type { OutlinerNode } from './schema';

/**
 * Asking the notebook a question.
 *
 * A portal embeds one rem you chose. A query embeds every rem that *matches*
 * something — which is the difference between a document store and a database
 * you can interrogate. "Everything I have made a flashcard of in this
 * document", "everything I touched this week", "every rem mentioning
 * mitochondria" are all one filter and a live list.
 *
 * The filter is deliberately small and closed. A real query language is a
 * project of its own, and four predicates that compose cover the questions a
 * notebook actually gets asked. Adding a fifth is a field here and a control
 * in the block; that is the whole extension story.
 */

export interface RemQuery {
  /** Free text, matched through the search index. */
  text?: string;
  /** Only rems that currently generate flashcards. */
  hasCards?: boolean;
  /** Only rems written or edited in the last N days. */
  editedWithinDays?: number;
  /** Only rems inside this document. */
  inPage?: string;
  /** Rems linking to this one. */
  linksTo?: string;
  limit?: number;
}

export const DEFAULT_LIMIT = 25;

/** An empty filter matches nothing — a query with no question is not a question. */
export function isEmptyQuery(query: RemQuery): boolean {
  return (
    !query.text?.trim() &&
    !query.hasCards &&
    !query.editedWithinDays &&
    !query.inPage &&
    !query.linksTo
  );
}

/** Read a filter off a node attribute, tolerating anything that isn't one. */
export function parseQuery(raw: unknown): RemQuery {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return normalizeQuery(parsed);
  } catch {
    return {};
  }
}

export function normalizeQuery(raw: unknown): RemQuery {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as Record<string, unknown>;
  const query: RemQuery = {};

  if (typeof input.text === 'string' && input.text.trim()) query.text = input.text.trim();
  if (input.hasCards === true) query.hasCards = true;
  if (typeof input.editedWithinDays === 'number' && input.editedWithinDays > 0) {
    query.editedWithinDays = Math.floor(input.editedWithinDays);
  }
  if (typeof input.inPage === 'string' && input.inPage) query.inPage = input.inPage;
  if (typeof input.linksTo === 'string' && input.linksTo) query.linksTo = input.linksTo;
  if (typeof input.limit === 'number' && input.limit > 0) query.limit = Math.floor(input.limit);

  return query;
}

export function serializeQuery(query: RemQuery): string {
  return JSON.stringify(query);
}

/**
 * The predicates that can be answered from a row alone.
 *
 * `text` is not among them: it is answered by the search index, which knows
 * about prefixes and tokens in a way a substring test does not.
 */
export function matchesRow(node: OutlinerNode, query: RemQuery, now: number): boolean {
  if (node.deletedAt) return false;
  // A portal has no text of its own, and an empty rem is not an answer.
  if (node.isPortal || !node.plainText.trim()) return false;

  if (query.hasCards && !node.isCard) return false;

  if (query.editedWithinDays !== undefined) {
    const cutoff = now - query.editedWithinDays * 24 * 60 * 60 * 1000;
    if (node.updatedAt < cutoff) return false;
  }

  if (query.linksTo && !node.outboundLinks.includes(query.linksTo)) return false;

  return true;
}

export interface QueryResult {
  node: OutlinerNode;
  pageId: string | undefined;
}

/**
 * Run a filter.
 *
 * The order matters for cost, not for correctness: whichever predicate is most
 * selective narrows the candidate set first, and the rest are checked against
 * the rows. Free text goes through the search index — which since #17 is built
 * once and kept in step, so a query block re-running on every keystroke
 * elsewhere in the notebook is a map lookup rather than a table scan.
 */
export async function runQuery(query: RemQuery, now = Date.now()): Promise<QueryResult[]> {
  if (isEmptyQuery(query)) return [];
  const limit = query.limit ?? DEFAULT_LIMIT;

  // Pick the narrowest source the filter allows. Reading the whole table here
  // would re-create, per query block per keystroke, exactly the cost that
  // incremental sync was built to remove.
  let candidates: OutlinerNode[];
  let ranked = false;

  if (query.text) {
    // The index already ranks these; take a generous slice and filter down.
    const hits = await searchNodes(query.text, Math.max(limit * 4, 100));
    candidates = hits.map((hit) => hit.node);
    ranked = true;
  } else if (query.linksTo) {
    // multiEntry index — the cheapest question this database can be asked.
    candidates = await db.nodes.where('outboundLinks').equals(query.linksTo).toArray();
  } else if (query.editedWithinDays !== undefined) {
    const cutoff = now - query.editedWithinDays * 24 * 60 * 60 * 1000;
    candidates = await db.nodes.where('updatedAt').aboveOrEqual(cutoff).toArray();
  } else {
    // Only `hasCards` is left, and `isCard` cannot be indexed — IndexedDB
    // rejects boolean keys — so this one has to scan.
    candidates = await db.nodes.toArray();
  }

  const matched = candidates.filter((node) => matchesRow(node, query, now));

  // Text results keep the index's ranking; everything else reads newest first,
  // which is what "what have I been working on" wants.
  const ordered = ranked ? matched : matched.sort((a, b) => b.updatedAt - a.updatedAt);

  // Documents are resolved for the results only, not for every candidate and
  // not by indexing the whole table: a handful of parent hops each, memoised
  // across results that share a branch.
  const pageCache = new Map<string, string | undefined>();
  const results: QueryResult[] = [];

  for (const node of ordered) {
    if (results.length >= limit) break;
    let pageId = pageCache.get(node.id);
    if (!pageCache.has(node.id)) {
      pageId = (await findRootPage(node.id))?.id;
      pageCache.set(node.id, pageId);
    }
    if (query.inPage) {
      if (pageId !== query.inPage) continue;
      // The document's own title rem is the container, not something in it —
      // and clicking it would zoom you to where you already are.
      if (node.id === query.inPage) continue;
    }
    results.push({ node, pageId });
  }

  return results;
}

/** A short human reading of a filter, for the block's header. */
export function describeQuery(query: RemQuery, pageTitle?: string): string {
  const parts: string[] = [];
  if (query.text) parts.push(`matching “${query.text}”`);
  if (query.hasCards) parts.push('with flashcards');
  if (query.editedWithinDays) {
    parts.push(
      query.editedWithinDays === 1 ? 'edited today' : `edited in the last ${query.editedWithinDays} days`
    );
  }
  if (query.inPage) parts.push(pageTitle ? `in ${pageTitle}` : 'in this document');
  if (query.linksTo) parts.push('linking here');
  return parts.length === 0 ? 'No filter set' : `Rems ${parts.join(', ')}`;
}
