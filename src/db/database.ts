import Dexie, { type Table } from 'dexie';
import type { DictionaryEntry, Flashcard, OutlinerNode, PageFolder } from './schema';

export class OutlinerDB extends Dexie {
  nodes!: Table<OutlinerNode, string>;
  dictionary!: Table<DictionaryEntry, string>;
  folders!: Table<PageFolder, string>;
  cards!: Table<Flashcard, string>;

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
  }
}

export const db = new OutlinerDB();
