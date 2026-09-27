import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import { getCardsForNode, reconcileCards, toggleCardDirection } from './cardRepository';
import { getNode } from './repository';
import { addTextNode, resetDatabase, textDoc } from '../test/helpers';
import { facesFor } from '../tiptap/cardFaces';
import {
  childrenAnswerDoc,
  docToPlainText,
  parseDoc,
  splitListPrompt,
  splitMultiLinePrompt,
  type DocNode,
} from '../tiptap/docUtils';
import type { Flashcard } from './schema';

/**
 * List cards (`Prompt >>>`) and multi-line cards (`Prompt ::` with the answer
 * in the children) — the card shapes an outline already has.
 */

beforeEach(resetDatabase);

async function remWith(text: string) {
  const node = await addTextNode('rem', text);
  await reconcileCards(node);
  return node;
}

const plain = (doc: DocNode | null | undefined) => (doc ? docToPlainText(doc) : null);
const docs = (...texts: string[]) => texts.map((t) => parseDoc(textDoc(t)));

function card(kind: Flashcard['kind']): Flashcard {
  return { id: `rem::${kind}`, nodeId: 'rem', kind, clozeIndex: null } as Flashcard;
}

describe('recognising the markers', () => {
  it('reads a trailing >>> as a list prompt, and strips it', () => {
    expect(plain(splitListPrompt(parseDoc(textDoc('Stages of mitosis >>>'))))).toBe('Stages of mitosis');
    expect(plain(splitListPrompt(parseDoc(textDoc('Stages >>>   '))))).toBe('Stages');
  });

  it('ignores >>> anywhere but the end, and a marker with no prompt', () => {
    expect(splitListPrompt(parseDoc(textDoc('a >>> b')))).toBeNull();
    expect(splitListPrompt(parseDoc(textDoc('>>>')))).toBeNull();
    expect(splitListPrompt(parseDoc(textDoc('plain text')))).toBeNull();
  });

  it('reads a trailing :: as a multi-line prompt, but not an ordinary A :: B', () => {
    expect(plain(splitMultiLinePrompt(parseDoc(textDoc('What the liver does ::'))))).toBe('What the liver does');
    expect(splitMultiLinePrompt(parseDoc(textDoc('Liver :: detox')))).toBeNull();
  });

  it('keeps formatting in the prompt', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Krebs', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' cycle steps >>>' },
          ],
        },
      ],
    };
    const prompt = splitListPrompt(doc)!;
    expect(prompt.content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'bold' }]);
    expect(plain(prompt)).toBe('Krebs cycle steps');
  });
});

describe('deriving the cards', () => {
  it('makes one list card from a >>> rem', async () => {
    await remWith('Stages of mitosis >>>');
    const cards = await getCardsForNode('rem');
    expect(cards.map((c) => [c.id, c.kind])).toEqual([['rem::list', 'list']]);
    expect((await getNode('rem'))!.isCard).toBe(true);
  });

  it('ignores the direction toggle on a list card', async () => {
    await remWith('Stages >>>');
    await toggleCardDirection('rem');
    expect((await getCardsForNode('rem')).map((c) => c.kind)).toEqual(['list']);
  });

  it('keeps a multi-line card when an answer is typed onto its line, and back', async () => {
    await remWith('Liver ::');
    const [before] = await getCardsForNode('rem');
    expect(before?.id).toBe('rem::forward');
    await db.cards.update('rem::forward', { intervalDays: 12 });

    await db.nodes.update('rem', { content: textDoc('Liver :: detox') });
    await reconcileCards((await getNode('rem'))!);
    const [after] = await getCardsForNode('rem');
    // Same card, same schedule: finishing the line is not a new fact to learn.
    expect(after?.id).toBe('rem::forward');
    expect(after?.intervalDays).toBe(12);
  });

  it('retires the list card when the marker goes', async () => {
    await remWith('Stages >>>');
    await db.nodes.update('rem', { content: textDoc('Stages') });
    await reconcileCards((await getNode('rem'))!);
    expect(await getCardsForNode('rem')).toHaveLength(0);
  });
});

describe('the faces', () => {
  it('asks for every child, and answers with them in order', () => {
    const faces = facesFor(card('list'), textDoc('Stages of mitosis >>>'), docs('Prophase', 'Metaphase', 'Anaphase'))!;
    expect(plain(faces.front)).toContain('Stages of mitosis');
    expect(plain(faces.front)).toContain('Name all 3 items');
    expect(faces.back.content?.[0]?.type).toBe('orderedList');
    expect(plain(faces.back)).toBe('ProphaseMetaphaseAnaphase');
  });

  it('says so when there is nothing underneath yet', () => {
    const faces = facesFor(card('list'), textDoc('Stages >>>'), [])!;
    expect(plain(faces.back)).toMatch(/Nothing underneath/);
  });

  it('answers a multi-line card with bullets, and reverses it', () => {
    const forward = facesFor(card('forward'), textDoc('Liver ::'), docs('detox', 'bile'))!;
    expect(plain(forward.front)).toBe('Liver');
    expect(forward.back.content?.[0]?.type).toBe('bulletList');

    const backward = facesFor(card('backward'), textDoc('Liver ::'), docs('detox', 'bile'))!;
    expect(plain(backward.back)).toBe('Liver');
  });

  it('returns null when the rem stopped making that card', () => {
    expect(facesFor(card('list'), textDoc('no marker'), [])).toBeNull();
  });

  it('flattens a heading child into a list item the schema accepts', () => {
    const heading: DocNode = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'G1' }] }],
    };
    const answer = childrenAnswerDoc([heading, parseDoc(textDoc(''))], true);
    const items = answer.content?.[0]?.content ?? [];
    // The empty child is dropped rather than rendered as a blank item.
    expect(items).toHaveLength(1);
    expect(items[0]?.content?.[0]?.type).toBe('paragraph');
  });
});
