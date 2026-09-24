import { db } from './database';
import { createPage, deleteNode, getAllPages, getChildren } from './repository';
import { ensureFolderNamed, getAllFolders } from './folderRepository';
import { insertTree, subtreeAsDrafts, type DraftRem } from './treeInsert';
import { dailyTitle } from './dailyNotes';
import { asOneUndo, noteCreated, pushUndo, takeSnapshot } from './undo';
import type { OutlinerNode } from './schema';
import type { DocNode } from '../tiptap/docUtils';

/**
 * Templates: any page in the "Templates" folder.
 *
 * No template format, no editor for one — a template is written like any other
 * page, and `/template` stamps a copy of its body in where you are. Most study
 * notes are the same shape repeated (a lecture, a paper, a chapter), and
 * rebuilding that shape by hand each time is friction exactly where you want
 * none.
 *
 * Three placeholders are filled in on the way: `%date%` (2026-09-24),
 * `%time%` (14:05) and `%weekday%` (Thursday). Percent signs rather than
 * braces, because `{{…}}` already means a cloze.
 */

export const TEMPLATES_FOLDER_NAME = 'Templates';

export async function getTemplates(): Promise<OutlinerNode[]> {
  const folders = (await getAllFolders()).filter(
    (f) => f.name.trim().toLowerCase() === TEMPLATES_FOLDER_NAME.toLowerCase()
  );
  const ids = new Set(folders.flatMap((f) => f.pageIds));
  if (ids.size === 0) return [];
  return (await getAllPages()).filter((page) => ids.has(page.id));
}

/** A new, empty template page, filed where `/template` will find it. */
export async function createTemplate(title = 'New template'): Promise<string> {
  const folder = await ensureFolderNamed(TEMPLATES_FOLDER_NAME);
  return (await createPage(title, folder.id)).id;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function fillPlaceholders(text: string, now: Date): string {
  return text
    .replace(/%date%/gi, dailyTitle(now))
    .replace(/%time%/gi, `${pad(now.getHours())}:${pad(now.getMinutes())}`)
    .replace(/%weekday%/gi, now.toLocaleDateString(undefined, { weekday: 'long' }));
}

function fillDoc(doc: DocNode, now: Date): DocNode {
  if (doc.type === 'text' && doc.text) return { ...doc, text: fillPlaceholders(doc.text, now) };
  return doc.content ? { ...doc, content: doc.content.map((child) => fillDoc(child, now)) } : doc;
}

function fillDrafts(drafts: DraftRem[], now: Date): DraftRem[] {
  return drafts.map((d) => ({ ...d, doc: fillDoc(d.doc, now), children: fillDrafts(d.children ?? [], now) }));
}

/**
 * Stamp a template's body in after `atId`. When `atId` is an empty rem with
 * nothing under it — the usual case, since you typed `/template` into a fresh
 * bullet — the template takes its place instead of leaving a blank line above.
 * Returns the ids of the new top-level rems.
 */
export async function applyTemplate(templateId: string, atId: string, now = new Date()): Promise<string[]> {
  const drafts = fillDrafts(await subtreeAsDrafts(templateId), now);
  const at = await db.nodes.get(atId);
  if (!at) return [];
  const replace = !at.plainText.trim() && (await getChildren(atId)).length === 0 && at.parentId !== null;

  // One undo for the whole stamp, including the blank bullet it replaced.
  const entry = await takeSnapshot('Insert template', [at.parentId, atId]);
  const inserted = await asOneUndo(async () => {
    // Typed into a page's title: the body goes into the page, not beside it.
    const place = at.parentId === null ? { parentId: atId } : { afterId: atId };
    const result = await insertTree(drafts, place, 'Insert template');
    if (replace && result.topIds.length > 0) await deleteNode(atId);
    return result;
  });
  noteCreated(entry, inserted.ids);
  pushUndo(entry);
  return inserted.topIds;
}
