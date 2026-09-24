import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import { createPage, getChildren, getNode, updateContent } from './repository';
import { getUnlinkedReferences, linkMention } from './unlinked';
import { applyTemplate, createTemplate, fillPlaceholders, getTemplates } from './templates';
import { createPagesWithTrees, insertTree, subtreeAsDrafts } from './treeInsert';
import { getCardsForNode } from './cardRepository';
import { undoLast } from './undo';
import { resetDatabase, textDoc, childOrder } from '../test/helpers';
import { docFromText, docToPlainText, extractWikiLinks, linkFirstMention, mentionPattern, parseDoc } from '../tiptap/docUtils';
import { invalidateSearchIndex } from './searchIndex';

beforeEach(async () => {
  await resetDatabase();
  invalidateSearchIndex();
});

const write = (id: string, text: string) => updateContent(id, textDoc(text), text);

describe('mentions', () => {
  it('match whole words only, in any case', () => {
    const p = mentionPattern('Cell');
    expect(p.test('the cell wall')).toBe(true);
    expect(p.test('Cellular respiration')).toBe(false);
    expect(mentionPattern('RNA').test('mRNA vaccines')).toBe(false);
  });

  it('link the first plain mention, keeping the words as written', () => {
    const linked = linkFirstMention(docFromText('The mitochondria makes ATP; mitochondria again'), 'Mitochondria', 't1')!;
    expect(docToPlainText(linked)).toBe('The mitochondria makes ATP; mitochondria again');
    expect(extractWikiLinks(linked)).toEqual([{ targetId: 't1', title: 'Mitochondria', alias: 'mitochondria' }]);
  });

  it('never link inside code', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mitochondria', marks: [{ type: 'code' }] }] }],
    };
    expect(linkFirstMention(doc, 'Mitochondria', 't1')).toBeNull();
  });
});

describe('unlinked references', () => {
  it('finds rems naming a page without linking to it, and links them', async () => {
    const target = await createPage('Mitochondria');
    const notes = await createPage('Biology notes');
    const [first] = await childOrder(notes.id);
    await write(first!, 'Mitochondria make ATP');
    const other = await createPage('Unrelated');
    await write((await childOrder(other.id))[0]!, 'Nothing to see');

    const refs = await getUnlinkedReferences(target.id);
    expect(refs.map((r) => r.node.id)).toEqual([first]);
    expect(refs[0]?.sourcePage?.id).toBe(notes.id);

    expect(await linkMention(first!, target.id)).toBe(true);
    expect((await getNode(first!))?.outboundLinks).toEqual([target.id]);
    expect(await getUnlinkedReferences(target.id)).toEqual([]);
  });

  it("ignores rems inside the page itself, and titles too short to mean anything", async () => {
    const page = await createPage('Mitosis');
    await write((await childOrder(page.id))[0]!, 'Mitosis has four phases');
    expect(await getUnlinkedReferences(page.id)).toEqual([]);

    const short = await createPage('Ox');
    const elsewhere = await createPage('Farm');
    await write((await childOrder(elsewhere.id))[0]!, 'An ox pulls the cart');
    expect(await getUnlinkedReferences(short.id)).toEqual([]);
  });
});

describe('inserting trees', () => {
  it('puts a nested tree after a rem, links resolved and cards made, as one undo', async () => {
    const page = await createPage('Target');
    const anchor = (await childOrder(page.id))[0]!;
    const { topIds, ids } = await insertTree(
      [
        {
          doc: docFromText('Parent'),
          children: [{ doc: docFromText('Question :: Answer') }, { doc: parseDoc(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'wikiLink', attrs: { title: 'Target' } }] }] })) }],
        },
      ],
      { afterId: anchor }
    );
    expect(ids).toHaveLength(3);
    const order = (await getChildren(page.id)).map((c) => c.id);
    expect(order).toEqual([anchor, topIds[0]]);

    const [card, link] = await getChildren(topIds[0]!);
    expect(await getCardsForNode(card!.id)).toHaveLength(1);
    expect(link!.outboundLinks).toEqual([page.id]);

    await undoLast();
    expect((await getChildren(page.id)).map((c) => c.id)).toEqual([anchor]);
  });

  it('creates pages that link to each other in one pass', async () => {
    const [a, b] = await createPagesWithTrees([
      { title: docFromText('Alpha'), drafts: [{ doc: parseDoc(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'wikiLink', attrs: { title: 'Beta' } }] }] })) }] },
      { title: docFromText('Beta'), drafts: [] },
    ]);
    const [child] = await getChildren(a!);
    expect(child!.outboundLinks).toEqual([b]);
    expect((await getNode(b!))?.isPage).toBe(true);
  });
});

describe('templates', () => {
  it('fills in the date placeholders', () => {
    const when = new Date(2026, 8, 24, 9, 5);
    expect(fillPlaceholders('Lecture %date% at %time%', when)).toBe('Lecture 2026-09-24 at 09:05');
  });

  it('are the pages in the Templates folder', async () => {
    const id = await createTemplate('Lecture');
    await createPage('Not a template');
    expect((await getTemplates()).map((t) => t.id)).toEqual([id]);
  });

  it('stamp a copy of the template body in place of an empty bullet', async () => {
    const templateId = await createTemplate('Lecture');
    const [firstBody] = await childOrder(templateId);
    await write(firstBody!, 'Date: %date%');
    await insertTree([{ doc: docFromText('Key terms'), children: [{ doc: docFromText('term :: meaning') }] }], { afterId: firstBody! });

    const notes = await createPage('Week 3');
    const blank = (await childOrder(notes.id))[0]!;
    const inserted = await applyTemplate(templateId, blank, new Date(2026, 8, 24));

    const body = await getChildren(notes.id);
    expect(body.map((c) => c.plainText)).toEqual(['Date: 2026-09-24', 'Key terms']);
    expect(inserted).toEqual(body.map((c) => c.id));
    expect((await db.nodes.get(blank))?.deletedAt).not.toBeNull();
    // The template itself is untouched, and the copy has cards of its own.
    expect((await getChildren(templateId)).map((c) => c.plainText)).toEqual(['Date: %date%', 'Key terms']);
    const [term] = await getChildren(body[1]!.id);
    expect(await getCardsForNode(term!.id)).toHaveLength(1);

    // One undo takes the whole stamp back, blank bullet included.
    await undoLast();
    expect((await getChildren(notes.id)).map((c) => c.id)).toEqual([blank]);
  });

  it('copies a subtree faithfully as drafts', async () => {
    const page = await createPage('Src');
    await write((await childOrder(page.id))[0]!, 'one');
    const drafts = await subtreeAsDrafts(page.id);
    expect(drafts.map((d) => docToPlainText(d.doc))).toEqual(['one']);
  });
});
