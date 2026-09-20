import { parseDoc, renumberClozesInDoc } from '../tiptap/docUtils';
import type { OutlinerNode } from './schema';

/**
 * Fix blanks that already share a number, across the whole notebook.
 *
 * The editor repairs a collision the moment it appears, and `updateContent`
 * repairs anything written after this ships — but neither reaches a rem that
 * already holds a collision and is never edited again. That rem keeps two
 * blanks on one card, and at review time answering one silently reschedules the
 * other. This is the one pass that catches those.
 *
 * Pure over rows, like the v10 link backfill, so the thing that rewrites
 * everyone's notes can be tested directly.
 *
 * **Cards are not reconciled here.** A Dexie upgrade is not the place to derive
 * flashcards, and the important half is already done: after this, no two blanks
 * share a card, so no answer can silently reschedule a different blank. The
 * newly-numbered blank gets its own card the next time that rem is edited.
 */
export function planClozeRepair(nodes: OutlinerNode[]): OutlinerNode[] {
  const updates: OutlinerNode[] = [];

  for (const node of nodes) {
    // Cheap reject: the overwhelming majority of rems have no blanks at all.
    if (!node.content?.includes('"cloze"')) continue;

    const fixed = renumberClozesInDoc(parseDoc(node.content));
    // `updatedAt` is left alone deliberately: renumbering a blank is a
    // representation fix, not an edit, and bumping it would make every device
    // push its whole notebook on the next sync.
    if (fixed) updates.push({ ...node, content: JSON.stringify(fixed) });
  }

  return updates;
}
