import Dexie, { type Table } from 'dexie';
import type {
  DictionaryEntry,
  Flashcard,
  OutlinerNode,
  PageFolder,
  RemVersion,
  ReviewLogEntry,
  StoredImage,
  SyncBase,
} from './schema';
import { derivedNodeKeys, LEGACY_NODE_FIELDS } from './schema';
import { planLinkBackfill } from './linkBackfill';
import { planClozeRepair } from './clozeRepair';

export class OutlinerDB extends Dexie {
  nodes!: Table<OutlinerNode, string>;
  dictionary!: Table<DictionaryEntry, string>;
  folders!: Table<PageFolder, string>;
  cards!: Table<Flashcard, string>;
  reviews!: Table<ReviewLogEntry, string>;
  images!: Table<StoredImage, string>;
  versions!: Table<RemVersion, string>;
  syncBase!: Table<SyncBase, string>;

  constructor() {
    super('outliner-app-db');

    // Indexes: id (primary key), parentId (fetch children fast),
    // isPage (fetch sidebar list fast), updatedAt (future sync support)
    this.version(1).stores({
      nodes: 'id, parentId, isPage, updatedAt',
    });

    // v2: add a multiEntry index on outboundLinks so "who links to node X"
    // (backlinks) is an indexed lookup instead of a full table scan.
    this.version(2)
      .stores({
        nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
      })
      .upgrade(async (tx) => {
        await tx
          .table('nodes')
          .toCollection()
          .modify((node) => {
            if (!node.outboundLinks) node.outboundLinks = [];
          });
      });

    // v3: add portal fields (isPortal, portalTargetId) for embedding a live
    // view of one node inside another.
    this.version(3)
      .stores({
        nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
      })
      .upgrade(async (tx) => {
        await tx
          .table('nodes')
          .toCollection()
          .modify((node) => {
            if (node.isPortal === undefined) node.isPortal = false;
            if (node.portalTargetId === undefined) node.portalTargetId = null;
          });
      });

    // v4: switch `content` from plain text to a Tiptap JSON doc string, and
    // add `plainText` as the derived plain-text field used for search/links.
    // Existing plain-text content is wrapped into a single-paragraph doc so
    // old notes keep working after the upgrade.
    this.version(4)
      .stores({
        nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
      })
      .upgrade(async (tx) => {
        await tx
          .table('nodes')
          .toCollection()
          .modify((node) => {
            if (node.plainText === undefined) {
              const oldContent: string = typeof node.content === 'string' ? node.content : '';
              node.plainText = oldContent;
              node.content = JSON.stringify({
                type: 'doc',
                content: [{ type: 'paragraph', content: oldContent ? [{ type: 'text', text: oldContent }] : [] }],
              });
            }
          });
      });

    // v5: add `deletedAt` as a soft-delete tombstone. Deletions now set this
    // timestamp instead of physically removing the row, so cloud sync can
    // propagate a delete to other devices (a hard-deleted row disappearing
    // locally would otherwise just get re-downloaded from the server, since
    // there'd be nothing to signal "this was deleted, not just missing").
    this.version(5)
      .stores({
        nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
      })
      .upgrade(async (tx) => {
        await tx
          .table('nodes')
          .toCollection()
          .modify((node) => {
            if (node.deletedAt === undefined) node.deletedAt = null;
          });
      });

    // v6: dictionary entries for hover definitions and word navigation.
    this.version(6).stores({
      nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
      dictionary: 'id, word, updatedAt',
    });

    // v7: sidebar folders for grouping pages.
    this.version(7).stores({
      nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
      dictionary: 'id, word, updatedAt',
      folders: 'id, order, updatedAt',
    });

    // v8: flashcards, plus soft-delete tombstones on dictionary entries and
    // folders so those two tables can join `nodes` in cloud sync. Every synced
    // table now needs the same two fields the merge relies on: `updatedAt` to
    // decide who wins, and `deletedAt` so a delete is just another field
    // change rather than a row vanishing.
    this.version(8)
      .stores({
        nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
        dictionary: 'id, word, updatedAt',
        folders: 'id, order, updatedAt',
        cards: 'id, nodeId, dueAt, updatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table('nodes')
          .toCollection()
          .modify((node) => {
            if (node.isCard === undefined) node.isCard = false;
            if (node.cardDirection === undefined) node.cardDirection = 'forward';
          });
        await tx
          .table('dictionary')
          .toCollection()
          .modify((entry) => {
            if (entry.deletedAt === undefined) entry.deletedAt = null;
          });
        await tx
          .table('folders')
          .toCollection()
          .modify((folder) => {
            if (folder.deletedAt === undefined) folder.deletedAt = null;
          });
      });

    // v9: the review log. Append-only history of every grade, which card it
    // was, and the scheduling state on either side of it.
    //
    // There is no upgrade function because there is nothing to migrate: past
    // reviews were never recorded and cannot be reconstructed from card state,
    // so the table starts empty and fills from here on. That is the whole
    // argument for adding it before the notebook gets any bigger.
    //
    // Indexed on `cardId` (per-card history), `reviewedAt` (everything in a
    // date range, which is what every statistic wants) and `updatedAt` (the
    // field cloud sync compares on).
    this.version(9).stores({
      nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
      dictionary: 'id, word, updatedAt',
      folders: 'id, order, updatedAt',
      cards: 'id, nodeId, dueAt, updatedAt',
      reviews: 'id, cardId, nodeId, reviewedAt, updatedAt',
    });

    // v10: `[[Title]]` links carry the id of the rem they point at.
    //
    // No index changes — the id lives inside the stored Tiptap doc, so this is
    // a content migration rather than a schema one. Every existing link is
    // resolved by title once, here, and from then on the link survives its
    // target being renamed. Links whose title matches nothing are left as they
    // are: an unresolvable link is a link to a page that doesn't exist yet,
    // which is a state the app already understands.
    this.version(10)
      .stores({
        nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
        dictionary: 'id, word, updatedAt',
        folders: 'id, order, updatedAt',
        cards: 'id, nodeId, dueAt, updatedAt',
        reviews: 'id, cardId, nodeId, reviewedAt, updatedAt',
      })
      .upgrade(async (tx) => {
        const table = tx.table('nodes');
        const updates = planLinkBackfill(await table.toArray());
        if (updates.length > 0) await table.bulkPut(updates);
      });

    // v11: give every `{{blank}}` a number no other blank in its rem is using.
    //
    // Again no index changes — the numbers live inside the stored Tiptap doc.
    // Two blanks sharing a number shared one card, so answering one silently
    // rescheduled the other; typing blanks one at a time could never produce
    // that, but pasting a fragment from another rem, or splitting a rem in two,
    // produced it immediately. The editor and the write path both prevent it
    // from here on; this is the pass that fixes what is already stored.
    this.version(11)
      .stores({
        nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
        dictionary: 'id, word, updatedAt',
        folders: 'id, order, updatedAt',
        cards: 'id, nodeId, dueAt, updatedAt',
        reviews: 'id, cardId, nodeId, reviewedAt, updatedAt',
      })
      .upgrade(async (tx) => {
        const table = tx.table('nodes');
        const updates = planClozeRepair(await table.toArray());
        if (updates.length > 0) await table.bulkPut(updates);
      });

    // v12: images. The bytes of anything pasted or dropped into a rem, keyed by
    // the id its doc refers to. Nothing to migrate — no rem had an image
    // before — and it is the first upgrade to run with the pre-upgrade
    // snapshot (`migrationSafety.ts`) in place.
    //
    // Indexed on `uploadedAt` so a sync can find what it hasn't sent yet
    // without reading every image's bytes into memory — which is why "not
    // yet" is 0 rather than null: IndexedDB leaves null out of an index.
    this.version(12).stores({
      nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
      dictionary: 'id, word, updatedAt',
      folders: 'id, order, updatedAt',
      cards: 'id, nodeId, dueAt, updatedAt',
      reviews: 'id, cardId, nodeId, reviewedAt, updatedAt',
      images: 'id, updatedAt, uploadedAt',
    });

    // v13: version history. Past states of each rem's text, local to this
    // device. `[nodeId+savedAt]` answers both "this rem's history, newest
    // first" and "when was the last version kept" — the question every
    // content write asks — without reading any other rem's versions.
    this.version(13).stores({
      nodes: 'id, parentId, isPage, updatedAt, *outboundLinks',
      dictionary: 'id, word, updatedAt',
      folders: 'id, order, updatedAt',
      cards: 'id, nodeId, dueAt, updatedAt',
      reviews: 'id, cardId, nodeId, reviewedAt, updatedAt',
      images: 'id, updatedAt, uploadedAt',
      versions: 'id, [nodeId+savedAt], savedAt, reason',
    });

    // v14: two derived index keys on nodes (#16) and the sync base (#22).
    //
    // `getAllPages()` read every rem to find the pages, because `isPage` is a
    // boolean and IndexedDB won't index booleans; the `hasCards` query did the
    // same with `isCard`. `rootKey`/`cardKey` mirror them as strings present
    // only when true, kept right by the hooks below on every write — so no
    // call site has to remember them — and stripped before a row is synced.
    //
    // `syncBase` holds, per rem, the last copy both sides agreed on, which is
    // what lets sync merge field by field instead of whole rows.
    this.version(14)
      .stores({
        nodes: 'id, parentId, isPage, updatedAt, *outboundLinks, rootKey, cardKey',
        dictionary: 'id, word, updatedAt',
        folders: 'id, order, updatedAt',
        cards: 'id, nodeId, dueAt, updatedAt',
        reviews: 'id, cardId, nodeId, reviewedAt, updatedAt',
        images: 'id, updatedAt, uploadedAt',
        versions: 'id, [nodeId+savedAt], savedAt, reason',
        syncBase: 'id',
      })
      .upgrade(async (tx) => {
        await tx
          .table('nodes')
          .toCollection()
          .modify((node) => {
            const keys = derivedNodeKeys(node);
            if (keys.rootKey) node.rootKey = keys.rootKey;
            else delete node.rootKey;
            if (keys.cardKey) node.cardKey = keys.cardKey;
            else delete node.cardKey;
          });
      });

    // v15: `titleKey` for link matching by title (#15), and `childrenIds`
    // retired (#4) — a rem's children are found by `parentId`.
    this.version(15)
      .stores({
        nodes: 'id, parentId, isPage, updatedAt, *outboundLinks, rootKey, cardKey, titleKey',
        dictionary: 'id, word, updatedAt',
        folders: 'id, order, updatedAt',
        cards: 'id, nodeId, dueAt, updatedAt',
        reviews: 'id, cardId, nodeId, reviewedAt, updatedAt',
        images: 'id, updatedAt, uploadedAt',
        versions: 'id, [nodeId+savedAt], savedAt, reason',
        syncBase: 'id',
      })
      .upgrade(async (tx) => {
        await tx
          .table('nodes')
          .toCollection()
          .modify((node) => {
            normalizeNodeRow(node);
          });
      });

    // v16: a flashcard's `interval` is `intervalDays` (#27) — the unit in the
    // name, and not a Postgres keyword.
    //
    // Also `pdfKeys` (#53): the PDFs a rem holds or quotes, so a PDF's reader
    // can find its highlights and the rem it belongs to without reading every rem.
    this.version(16)
      .stores({
        nodes: 'id, parentId, isPage, updatedAt, *outboundLinks, rootKey, cardKey, titleKey, *pdfKeys',
        dictionary: 'id, word, updatedAt',
        folders: 'id, order, updatedAt',
        cards: 'id, nodeId, dueAt, updatedAt',
        reviews: 'id, cardId, nodeId, reviewedAt, updatedAt',
        images: 'id, updatedAt, uploadedAt',
        versions: 'id, [nodeId+savedAt], savedAt, reason',
        syncBase: 'id',
      })
      .upgrade(async (tx) => {
        await tx
          .table('nodes')
          .toCollection()
          .modify((node) => {
            normalizeNodeRow(node);
          });
        await tx
          .table('cards')
          .toCollection()
          .modify((card) => {
            normalizeCardRow(card);
          });
      });

    // Every row written to `nodes` — add, put, update, modify, bulk or not,
    // from the app, a sync pull, a restore or an upgrade — passes through
    // here on its way to IndexedDB. Deriving the index keys at this one
    // point, rather than in hooks or at call sites, is what makes them
    // impossible to get wrong: there is no write path that skips it.
    this.use({
      stack: 'dbcore',
      name: 'nodeRowNormalizer',
      create(down) {
        return {
          ...down,
          table(tableName) {
            const table = down.table(tableName);
            const normalize: ((value: unknown) => unknown) | null =
              tableName === 'nodes'
                ? (value) => normalizeNodeRow({ ...(value as OutlinerNode) })
                : tableName === 'cards'
                  ? (value) => normalizeCardRow({ ...(value as Flashcard) })
                  : null;
            if (!normalize) return table;
            return {
              ...table,
              mutate(req) {
                if (req.type !== 'add' && req.type !== 'put') return table.mutate(req);
                return table.mutate({ ...req, values: req.values.map(normalize) });
              },
            };
          },
        };
      },
    });
  }
}

/**
 * A card row as it should be stored. Rows from before v16 — a backup, or a
 * download from a device not yet updated — call the interval `interval`;
 * whichever arrives, it is kept as `intervalDays`.
 */
export function normalizeCardRow(card: Flashcard): Flashcard {
  const legacy = card as unknown as Record<string, unknown>;
  if ('interval' in legacy) {
    if (typeof card.intervalDays !== 'number' && typeof legacy.interval === 'number') card.intervalDays = legacy.interval;
    delete legacy.interval;
  }
  return card;
}

/** A node row as it should be stored: derived keys current, retired fields gone. */
export function normalizeNodeRow(node: OutlinerNode): OutlinerNode {
  applyDerivedKeys(node);
  for (const field of LEGACY_NODE_FIELDS) delete (node as unknown as Record<string, unknown>)[field];
  return node;
}

/** Set or clear a row's derived index keys in place. */
function applyDerivedKeys(node: OutlinerNode): void {
  const keys = derivedNodeKeys(node);
  if (keys.rootKey) node.rootKey = keys.rootKey;
  else delete node.rootKey;
  if (keys.cardKey) node.cardKey = keys.cardKey;
  else delete node.cardKey;
  if (keys.titleKey) node.titleKey = keys.titleKey;
  else delete node.titleKey;
  if (keys.pdfKeys.length > 0) node.pdfKeys = keys.pdfKeys;
  else delete node.pdfKeys;
}

export const db = new OutlinerDB();
