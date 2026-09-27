import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import { addHighlight, highlightsFor, pdfInfo } from './pdfRepository';
import { findUnusedImages, storePdf } from './imageRepository';
import { getCardsForNode } from './cardRepository';
import { addChild, addTextNode, childOrder, resetDatabase } from '../test/helpers';
import { docToPlainText, parseDoc } from '../tiptap/docUtils';
import { pdfIdsIn } from './schema';
import { encodeRects } from '../pdf/geometry';
import { docToMarkdown } from '../export/markdown';

beforeEach(resetDatabase);

const DAY = 24 * 60 * 60 * 1000;

function blockDoc(fileId: string, name = 'Lecture notes') {
  return JSON.stringify({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Reading: ' }] },
      { type: 'remPdf', attrs: { fileId, name, size: 1234 } },
    ],
  });
}

async function pdfRem(fileId = 'file-1') {
  const page = await addTextNode('page', 'Biology', { isPage: true });
  const holder = await addChild(page, 'holder', 'x', { content: blockDoc(fileId), plainText: 'Reading: Lecture notes' });
  return { page, holder };
}

const rects = [{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }];

describe('PDFs in the outline (#53)', () => {
  it('stores a PDF with the images, whole', async () => {
    const stored = await storePdf(new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' }));
    expect(stored.mime).toBe('application/pdf');
    expect((await db.images.get(stored.id))?.size).toBe(4);
    await expect(storePdf(new Blob(['x'], { type: 'image/png' }))).rejects.toThrow("isn't a PDF");
  });

  it('indexes the PDFs a rem holds or quotes, without parsing docs that have none', async () => {
    expect(pdfIdsIn(blockDoc('abc'))).toEqual(['abc']);
    expect(pdfIdsIn('{"type":"doc","content":[]}')).toEqual([]);
    await pdfRem('f1');
    expect(await db.nodes.where('pdfKeys').equals('f1').primaryKeys()).toEqual(['holder']);
  });

  it('knows a PDF by the rem that holds it', async () => {
    await pdfRem('f1');
    expect(await pdfInfo('f1')).toEqual({ fileId: 'f1', name: 'Lecture notes', homeId: 'holder' });
    expect(await pdfInfo('nope')).toBeUndefined();
  });

  it('a highlight is a rem under the PDF’s rem, starting with its page chip', async () => {
    await pdfRem('f1');
    const made = await addHighlight({ fileId: 'f1', page: 3, rects, text: 'Osmosis moves water.' });
    expect(await childOrder('holder')).toEqual([made!.nodeId]);
    const row = (await db.nodes.get(made!.nodeId))!;
    expect(row.plainText).toBe('Osmosis moves water.');
    const first = parseDoc(row.content).content![0]!.content![0]!;
    expect(first).toMatchObject({ type: 'pdfAnchor', attrs: { fileId: 'f1', page: 3, rects: encodeRects(rects) } });
    expect(made!.cursor).toBe(2 + ' Osmosis moves water.'.length);
    expect(await highlightsFor('f1')).toEqual([{ nodeId: made!.nodeId, page: 3, rects, text: 'Osmosis moves water.' }]);
  });

  it('a card has the passage as its answer and the cursor in its empty question', async () => {
    await pdfRem('f1');
    const made = await addHighlight({ fileId: 'f1', page: 1, rects, text: 'Ribosomes build proteins.', asCard: true });
    const cards = await getCardsForNode(made!.nodeId);
    expect(cards.map((c) => c.kind)).toEqual(['forward']);
    expect(made!.cursor).toBe(3);
    expect((await db.nodes.get(made!.nodeId))?.plainText).toBe(':: Ribosomes build proteins.');
  });

  it('falls back to a given rem when the PDF’s own is gone', async () => {
    await addTextNode('elsewhere', 'Elsewhere', { isPage: true });
    const made = await addHighlight({ fileId: 'orphan', page: 1, rects, text: 'q', fallbackParentId: 'elsewhere' });
    expect(await childOrder('elsewhere')).toEqual([made!.nodeId]);
    expect(await addHighlight({ fileId: 'orphan', page: 1, rects, text: 'q' })).toBeNull();
  });

  it('reads as its name in plain text, and a page chip adds nothing', () => {
    expect(docToPlainText(parseDoc(blockDoc('f', 'Paper')))).toBe('Reading: Paper');
  });

  it('exports as a link to the file and a page citation', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'pdfAnchor', attrs: { fileId: 'f', page: 7, rects: '[]' } }, { type: 'text', text: ' A quote' }] },
        { type: 'remPdf', attrs: { fileId: 'f', name: 'Paper' } },
      ],
    };
    const md = docToMarkdown(doc);
    expect(md).toContain('(p. 7) A quote');
    expect(md).toContain('[Paper](clemnotes-pdf:f)');
  });

  it('the image clean-up keeps a PDF any rem holds or quotes', async () => {
    const stored = await storePdf(new Blob([new Uint8Array([1])], { type: 'application/pdf' }), Date.now() - 30 * DAY);
    const unused = await storePdf(new Blob([new Uint8Array([2])], { type: 'application/pdf' }), Date.now() - 30 * DAY);
    await pdfRem(stored.id);
    const found = await findUnusedImages();
    expect(found.ids).toEqual([unused.id]);
  });
});
