import { buildSubtrees } from '../export/tree';
import { remsToMarkdown } from '../export/markdown';
import { getNode } from './repository';

/**
 * Getting a rem *out* of the app.
 *
 * Selecting the rendered text and copying loses the structure, which is the
 * only part an outline really has. These two put the structure on the
 * clipboard instead: the subtree as nested Markdown bullets, or a `[[link]]`
 * that resolves back to the rem you copied it from.
 */

/** Write to the clipboard, reporting whether it worked rather than throwing. */
async function write(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Denied permission, an insecure origin, or no clipboard at all. The
    // caller says so rather than the app appearing to have done nothing.
    return false;
  }
}

/** One or more rems and everything under them, as nested Markdown bullets. */
export async function copyRemsAsMarkdown(ids: string[]): Promise<boolean> {
  if (ids.length === 0) return false;
  return write(remsToMarkdown(await buildSubtrees(ids)));
}

/**
 * A `[[Title]]` pointing at this rem.
 *
 * Pasted into another rem, the input rule turns it back into a real link — by
 * title, since the clipboard carries text and not attributes. That is the same
 * resolution a hand-typed link gets, which is the honest behaviour: the id
 * cannot survive a trip through a plain-text clipboard.
 */
export async function copyLinkToRem(id: string): Promise<boolean> {
  const node = await getNode(id);
  if (!node) return false;
  return write(`[[${node.plainText.trim() || 'Untitled'}]]`);
}
