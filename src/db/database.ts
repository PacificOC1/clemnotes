import Dexie, { type Table } from 'dexie';
import type { OutlinerNode } from './schema';

export class OutlinerDB extends Dexie {
  nodes!: Table<OutlinerNode, string>;

  constructor() {
    super('outliner-app-db');

    // Indexes: id (primary key), parentId (fetch children fast),
    // isPage (fetch sidebar list fast), updatedAt (future sync support)
    this.version(1).stores({
      nodes: 'id, parentId, isPage, updatedAt',
    });
  }
}

export const db = new OutlinerDB();
