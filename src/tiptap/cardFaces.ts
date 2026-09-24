import {
  childrenAnswerDoc,
  parseDoc,
  renderCloze,
  splitListPrompt,
  splitMultiLinePrompt,
  splitOnSeparator,
  type DocNode,
} from './docUtils';
import type { Flashcard } from '../db/schema';

export interface Faces {
  front: DocNode;
  back: DocNode;
}

/** A small grey line under a prompt — how many items a list card is asking for. */
function hint(text: string): DocNode {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text, marks: [{ type: 'italic' }] }],
  };
}

function withBlocks(doc: DocNode, ...blocks: DocNode[]): DocNode {
  return { type: 'doc', content: [...(doc.content ?? []), ...blocks] };
}

/**
 * What to show on each side of a card.
 *
 * `children` are the stored docs of the rem's children, in order — the answer
 * for a list card and for an `A ::` card with nothing after the separator.
 * They are read at review time rather than frozen into the card, so adding an
 * item to a list is a change to the card's answer and not a new card.
 *
 * Returns null when the rem no longer makes the card it is being asked for,
 * which the review screen shows as "this card's rem changed".
 */
export function facesFor(card: Flashcard, content: string, children: DocNode[] = []): Faces | null {
  const doc = parseDoc(content);

  if (card.kind === 'cloze') {
    const index = card.clozeIndex ?? 1;
    return { front: renderCloze(doc, index, false), back: renderCloze(doc, index, true) };
  }

  if (card.kind === 'list') {
    const prompt = splitListPrompt(doc);
    if (!prompt) return null;
    const answer = childrenAnswerDoc(children, true);
    const count = answer.content?.[0]?.type === 'orderedList' ? answer.content[0].content?.length ?? 0 : 0;
    return {
      front: withBlocks(prompt, hint(count === 1 ? 'Name the 1 item' : `Name all ${count} items`)),
      back: answer,
    };
  }

  const sides = splitOnSeparator(doc);
  if (sides) return card.kind === 'backward' ? { front: sides.back, back: sides.front } : sides;

  const question = splitMultiLinePrompt(doc);
  if (!question) return null;
  const answer = childrenAnswerDoc(children, false);
  return card.kind === 'backward' ? { front: answer, back: question } : { front: question, back: answer };
}

export function kindLabel(card: Flashcard): string {
  if (card.kind === 'cloze') return `Cloze ${card.clozeIndex ?? 1}`;
  if (card.kind === 'list') return 'List';
  return card.kind === 'backward' ? 'Reverse' : 'Forward';
}
