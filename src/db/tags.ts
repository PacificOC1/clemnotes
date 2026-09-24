import { createPage, getAllPages } from './repository';
import { ensureFolderNamed } from './folderRepository';
import { extractTags, parseDoc } from '../tiptap/docUtils';
import type { OutlinerNode } from './schema';

/**
 * `#tags`.
 *
 * A tag points at a page — the tag's page — exactly as a link does, and that
 * page is where everything tagged with it is listed. So there is no tag table
 * and no tag index: a tag is a rem like everything else, and "everything
 * tagged #exam" is the tag page's backlinks, filtered to the ones that got
 * there by tagging rather than by linking.
 *
 * New tag pages are filed under a "Tags" folder so they don't crowd the
 * sidebar. Any page can be used as a tag, though — tagging something with a
 * page you already have is the point, not an accident.
 */

export const TAGS_FOLDER_NAME = 'Tags';

/** `#Exam ` → `Exam`. What the picker's query and a query filter both store. */
export function normalizeTagName(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim();
}

/** Characters a tag can be typed with. Letters and digits in any script, plus `_ - /`. */
export const TAG_CHARS = '[\\p{L}\\p{N}_\\-/]';

/** Every live page whose title is `name`, oldest first. */
export async function findTagPages(name: string): Promise<OutlinerNode[]> {
  const wanted = normalizeTagName(name).toLowerCase();
  if (!wanted) return [];
  return (await getAllPages())
    .filter((page) => page.plainText.trim().toLowerCase() === wanted)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Pages to offer in the `#` picker: titles starting with what you typed first,
 * then titles containing it. Only pages — tagging something with a bullet
 * buried in another document is what a link is for.
 */
export async function searchTagPages(query: string, limit = 8): Promise<OutlinerNode[]> {
  const q = normalizeTagName(query).toLowerCase();
  const pages = (await getAllPages()).filter((p) => p.plainText.trim());
  const scored = pages
    .map((page) => {
      const title = page.plainText.trim().toLowerCase();
      const score = title === q ? 0 : title.startsWith(q) ? 1 : title.includes(q) ? 2 : 3;
      return { page, score };
    })
    .filter((entry) => entry.score < 3)
    .sort((a, b) => a.score - b.score || a.page.plainText.length - b.page.plainText.length);
  return scored.slice(0, limit).map((entry) => entry.page);
}

/** The page for a tag, made (and filed under Tags) if there isn't one. Returns its id. */
export async function ensureTagPage(name: string): Promise<string> {
  const clean = normalizeTagName(name);
  const [existing] = await findTagPages(clean);
  if (existing) return existing.id;
  const folder = await ensureFolderNamed(TAGS_FOLDER_NAME);
  return (await createPage(clean, folder.id)).id;
}

/**
 * Does this rem carry one of these tags?
 *
 * By id first, and by name for a tag that has none (one written before its
 * page existed, or restored from Markdown): the same two ways a link resolves.
 */
export function remHasTag(node: OutlinerNode, tagIds: ReadonlySet<string>, names: ReadonlySet<string>): boolean {
  return extractTags(parseDoc(node.content)).some(
    (tag) => (tag.targetId !== null && tagIds.has(tag.targetId)) || names.has(tag.title.trim().toLowerCase())
  );
}
