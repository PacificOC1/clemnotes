import { db } from './database';
import { insertTree } from './treeInsert';
import { parseDoc, type DocNode } from '../tiptap/docUtils';
import { decodeRects, encodeRects, type PageRect } from '../pdf/geometry';
import type { OutlinerNode } from './schema';

/**
 * PDFs in the outline (#53).
 *
 * A PDF lives in a rem as a block (`remPdf`) that holds only the id of its
 * bytes, stored like an image. Reading it opens it beside the outline; every
 * passage you highlight becomes a rem under the one holding the PDF, starting
 * with a page chip (`pdfAnchor`) that remembers exactly where on which page
 * the passage is. The chip is how the rem gets back to the PDF, and how the
 * PDF finds its highlights to draw — through the `pdfKeys` index, never a
 * scan.
 */

export interface PdfInfo {
  fileId: string;
  name: string;
  /** The rem holding the PDF block — where new highlights go. */
  homeId: string;
}

export interface PdfHighlight {
  nodeId: string;
  page: number;
  rects: PageRect[];
  /** The rem's text, for a tooltip. */
  text: string;
}

function findNodes(doc: DocNode, type: string, fileId: string, into: DocNode[] = []): DocNode[] {
  if (doc.type === type && doc.attrs?.fileId === fileId) into.push(doc);
  for (const child of doc.content ?? []) findNodes(child, type, fileId, into);
  return into;
}

async function remsFor(fileId: string): Promise<OutlinerNode[]> {
  const rows = await db.nodes.where('pdfKeys').equals(fileId).toArray();
  return rows.filter((row) => !row.deletedAt);
}

/** The PDF's name and the rem it belongs to — the oldest one holding its block. */
export async function pdfInfo(fileId: string): Promise<PdfInfo | undefined> {
  const holders = (await remsFor(fileId))
    .map((row) => ({ row, block: findNodes(parseDoc(row.content), 'remPdf', fileId)[0] }))
    .filter((entry) => entry.block)
    .sort((a, b) => a.row.createdAt - b.row.createdAt);
  const first = holders[0];
  if (!first) return undefined;
  return { fileId, name: String(first.block!.attrs?.name ?? '') || 'PDF', homeId: first.row.id };
}

/** Every highlight on a PDF, from the rems whose page chips point into it. */
export async function highlightsFor(fileId: string): Promise<PdfHighlight[]> {
  const out: PdfHighlight[] = [];
  for (const row of await remsFor(fileId)) {
    for (const anchor of findNodes(parseDoc(row.content), 'pdfAnchor', fileId)) {
      const rects = decodeRects(anchor.attrs?.rects);
      if (rects.length === 0) continue;
      out.push({ nodeId: row.id, page: Number(anchor.attrs?.page ?? 1), rects, text: row.plainText.trim() });
    }
  }
  return out.sort((a, b) => a.page - b.page || a.rects[0]!.y - b.rects[0]!.y);
}

export interface NewHighlight {
  fileId: string;
  /** 1-based. */
  page: number;
  rects: PageRect[];
  text: string;
  /** A flashcard with the passage as its answer, rather than a plain quote. */
  asCard?: boolean;
  /** Where to put it when the PDF's own rem can't be found (its block was deleted). */
  fallbackParentId?: string | null;
}

/** The chip that starts a highlight rem. */
export function anchorNode(fileId: string, page: number, rects: PageRect[]): DocNode {
  return { type: 'pdfAnchor', attrs: { fileId, page, rects: encodeRects(rects) } };
}

/**
 * Add a highlight as the last child of the PDF's rem. Returns the new rem and
 * where its cursor belongs: at the end of a quote, or — for a card — in the
 * empty question in front of the `::`, ready to type.
 */
export async function addHighlight(input: NewHighlight): Promise<{ nodeId: string; cursor: number } | null> {
  const home = (await pdfInfo(input.fileId))?.homeId ?? input.fallbackParentId;
  if (!home) return null;
  const anchor = anchorNode(input.fileId, input.page, input.rects);
  const text = input.asCard ? `  :: ${input.text}` : ` ${input.text}`;
  const doc: DocNode = { type: 'doc', content: [{ type: 'paragraph', content: [anchor, { type: 'text', text }] }] };
  const { topIds } = await insertTree([{ doc }], { parentId: home }, input.asCard ? 'New card from PDF' : 'Highlight');
  const nodeId = topIds[0];
  if (!nodeId) return null;
  // Positions inside the paragraph: 1 is before the chip, 2 after it, 3 after the space.
  return { nodeId, cursor: input.asCard ? 3 : 2 + text.length };
}
