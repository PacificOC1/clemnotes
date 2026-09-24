import { createPagesWithTrees, type DraftPage, type DraftRem } from '../db/treeInsert';
import { ensureFolderNamed } from '../db/folderRepository';
import { findTagPages, TAGS_FOLDER_NAME } from '../db/tags';
import { storeImage } from '../db/imageRepository';
import { docFromText, type DocNode } from '../tiptap/docUtils';
import { parseMarkdownFiles } from './markdown';

/**
 * Importing Markdown: loose `.md` files, or a whole folder (an Obsidian vault)
 * with the images it refers to.
 *
 * Every imported page is filed in one folder named after what was imported,
 * so a 300-note vault arrives as one tidy group rather than 300 new rows in
 * "Unfiled". Links between the imported notes resolve to each other; tags get
 * pages; images referenced by path are found among the selected files and
 * stored like pasted ones.
 */

export interface ImportFile {
  /** Path within what was picked — `webkitRelativePath` for a folder, the name otherwise. */
  path: string;
  file: Blob;
}

export interface MarkdownImportReport {
  pages: number;
  rems: number;
  images: number;
  missingImages: string[];
  tags: number;
  folder: string;
}

const TEXT = /\.(md|markdown|txt)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

function normalizePath(path: string): string {
  let clean = path.replace(/\\/g, '/').replace(/^\.\//, '');
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // Keep it as written.
  }
  return clean.toLowerCase();
}

const baseName = (path: string) => normalizePath(path).split('/').pop() ?? '';

function countRems(drafts: DraftRem[]): number {
  return drafts.reduce((n, d) => n + 1 + countRems(d.children ?? []), 0);
}

/** Swap every image placeholder for a stored image (or a note saying it's missing). */
async function resolveImages(
  drafts: DraftRem[],
  find: (src: string) => ImportFile | undefined,
  stats: { images: number; missing: string[] }
): Promise<void> {
  const walk = async (node: DocNode): Promise<DocNode> => {
    if (node.type === 'remImage' && typeof node.attrs?.src === 'string') {
      const src = node.attrs.src;
      const found = /^https?:/i.test(src) ? undefined : find(src);
      if (found) {
        try {
          const ext = found.path.split('.').pop()?.toLowerCase() ?? '';
          const blob = found.file.type ? found.file : new Blob([found.file], { type: MIME[ext] ?? 'image/png' });
          const stored = await storeImage(blob);
          stats.images += 1;
          return { type: 'remImage', attrs: { imageId: stored.id, alt: node.attrs.alt ?? '', size: 'full' } };
        } catch {
          // Fall through to the note below.
        }
      }
      stats.missing.push(src);
      return docFromText(`[image: ${src}]`).content![0]!;
    }
    if (!node.content) return node;
    return { ...node, content: await Promise.all(node.content.map(walk)) };
  };
  for (const draft of drafts) {
    draft.doc = await walk(draft.doc);
    await resolveImages(draft.children ?? [], find, stats);
  }
}

export async function importMarkdownFiles(files: ImportFile[], folderName: string): Promise<MarkdownImportReport> {
  const textFiles = files.filter((f) => TEXT.test(f.path));
  const images = files.filter((f) => IMAGE.test(f.path));
  const byPath = new Map(images.map((f) => [normalizePath(f.path), f]));
  const byName = new Map(images.map((f) => [baseName(f.path), f]));
  const root = normalizePath(textFiles[0]?.path ?? '').split('/')[0] ?? '';

  // Relative to the note or to the vault root, or just by name, which is how
  // Obsidian's `![[shot.png]]` finds things.
  const find = (src: string) => {
    const clean = normalizePath(src);
    return byPath.get(clean) ?? byPath.get(`${root}/${clean}`) ?? byName.get(baseName(src));
  };

  const parsed = parseMarkdownFiles(
    await Promise.all(textFiles.map(async (f) => ({ name: f.path, text: await f.file.text() })))
  );

  const stats = { images: 0, missing: [] as string[] };
  for (const page of parsed.pages) await resolveImages(page.drafts, find, stats);

  const folder = await ensureFolderNamed(folderName);
  const pages: DraftPage[] = parsed.pages.map((page) => ({
    title: docFromText(page.title),
    drafts: page.drafts,
    folderId: folder.id,
  }));

  // Tags need pages to be listed on. One per tag that doesn't already have
  // one — here, or among the pages being imported.
  const importedTitles = new Set(parsed.pages.map((p) => p.title.trim().toLowerCase()));
  const newTags: string[] = [];
  for (const tag of parsed.tags) {
    if (importedTitles.has(tag.toLowerCase())) continue;
    if ((await findTagPages(tag)).length > 0) continue;
    if (newTags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    newTags.push(tag);
  }
  if (newTags.length > 0) {
    const tagsFolder = await ensureFolderNamed(TAGS_FOLDER_NAME);
    for (const tag of newTags) pages.push({ title: docFromText(tag), drafts: [], folderId: tagsFolder.id });
  }

  await createPagesWithTrees(pages);

  return {
    pages: parsed.pages.length,
    rems: parsed.pages.reduce((n, p) => n + countRems(p.drafts), 0),
    images: stats.images,
    missingImages: stats.missing,
    tags: newTags.length,
    folder: folder.name,
  };
}
