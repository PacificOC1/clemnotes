// Core "everything is a node" data model.
// A page is just a Node with parentId === null.

export interface OutlinerNode {
  id: string;
  content: string; // plain text for MVP; will become RichText[] once Tiptap is added
  parentId: string | null;
  childrenIds: string[];
  order: number; // fractional sibling order key
  collapsed: boolean;
  isPage: boolean; // true for top-level "documents" shown in the sidebar
  createdAt: number;
  updatedAt: number;
}

export function createEmptyNode(overrides: Partial<OutlinerNode> = {}): Omit<OutlinerNode, 'id'> {
  const now = Date.now();
  return {
    content: '',
    parentId: null,
    childrenIds: [],
    order: now, // timestamp-based order is a fine default; real fractional
                // reordering logic lives in repository.ts's insertBetween()
    collapsed: false,
    isPage: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
