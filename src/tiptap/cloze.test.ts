import { describe, expect, it } from 'vitest';
import {
  extractClozeIndices,
  maxClozeIndex,
  parseDoc,
  renumberClozesInDoc,
  renumberedClozeIndices,
} from './docUtils';
import { planClozeRepair } from '../db/clozeRepair';
import { createEmptyNode, type OutlinerNode } from '../db/schema';

describe('renumberedClozeIndices', () => {
  it('leaves a sequence that is already unique alone', () => {
    expect(renumberedClozeIndices([1, 2, 3])).toBeNull();
    expect(renumberedClozeIndices([])).toBeNull();
    expect(renumberedClozeIndices([1])).toBeNull();
  });

  it('leaves gaps alone', () => {
    // 1, 3, 7 works perfectly well — each blank has its own card. Tidying it
    // to 1, 2, 3 would change every card id and throw away the scheduling.
    expect(renumberedClozeIndices([1, 3, 7])).toBeNull();
    expect(renumberedClozeIndices([5, 2])).toBeNull();
  });

  it('moves the later of two blanks sharing a number', () => {
    // The bug: sharing a number means sharing a card, so answering one
    // silently reschedules the other.
    expect(renumberedClozeIndices([1, 1])).toEqual([1, 2]);
  });

  it('gives a duplicate the lowest number nobody wants', () => {
    // 2 is taken by the third blank, so the duplicate takes 3 rather than
    // colliding again.
    expect(renumberedClozeIndices([1, 1, 2])).toEqual([1, 3, 2]);
  });

  it('handles a whole fragment pasted on top of itself', () => {
    expect(renumberedClozeIndices([1, 2, 1, 2])).toEqual([1, 2, 3, 4]);
  });

  it('handles three of a kind', () => {
    expect(renumberedClozeIndices([1, 1, 1])).toEqual([1, 2, 3]);
  });

  it('keeps the first claimant, whatever its number', () => {
    expect(renumberedClozeIndices([4, 4])).toEqual([4, 1]);
  });

  it('writes back a nonsense index rather than leaving it to be coerced', () => {
    // Everything that reads a cloze coerces a bad index to 1 — so the card is
    // keyed on 1 while the node still says -3, and `renderCloze` never matches
    // it, leaving a card that blanks nothing. Fixing the stored value is the
    // whole point.
    expect(renumberedClozeIndices([Number.NaN, 1])).toEqual([1, 2]);
    expect(renumberedClozeIndices([0, 1])).toEqual([1, 2]);
    expect(renumberedClozeIndices([-3, 2])).toEqual([1, 2]);
    expect(renumberedClozeIndices([1.7])).toEqual([1]);
  });

  it('is stable — running it again changes nothing', () => {
    const once = renumberedClozeIndices([1, 1, 2, 2, 1]);
    expect(once).not.toBeNull();
    expect(renumberedClozeIndices(once!)).toBeNull();
  });

  it('produces a set with no duplicates, whatever went in', () => {
    const inputs = [
      [1, 1, 1, 1],
      [2, 2, 3, 3, 1],
      [9, 9, 9, 1, 1],
      [1, 2, 2, 4, 4, 4],
    ];
    for (const input of inputs) {
      const out = renumberedClozeIndices(input) ?? input;
      expect(new Set(out).size).toBe(out.length);
    }
  });
});

describe('the helpers it works with', () => {
  const doc = parseDoc(
    JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'cloze', attrs: { index: 1, text: 'a' } },
            { type: 'text', text: ' and ' },
            { type: 'cloze', attrs: { index: 3, text: 'b' } },
          ],
        },
      ],
    })
  );

  it('reads the indices a doc contains, in order', () => {
    expect(extractClozeIndices(doc)).toEqual([1, 3]);
  });

  it('numbers the next blank past the highest', () => {
    expect(maxClozeIndex(doc)).toBe(3);
  });
});

/** A doc whose blanks carry the given indices, in order. */
function clozeDoc(...indices: number[]): string {
  return JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: indices.map((index, i) => ({
          type: 'cloze',
          attrs: { index, text: `blank ${i}` },
        })),
      },
    ],
  });
}

const indicesOf = (content: string) => extractClozeIndices(parseDoc(content));
const orderedIndices = (content: string) =>
  [...content.matchAll(/"index":(\d+)/g)].map((m) => Number(m[1]));

describe('renumberClozesInDoc', () => {
  it('rewrites only the blanks that moved', () => {
    const fixed = renumberClozesInDoc(parseDoc(clozeDoc(1, 1, 2)));
    expect(orderedIndices(JSON.stringify(fixed))).toEqual([1, 3, 2]);
  });

  it('returns null when there is nothing to fix', () => {
    expect(renumberClozesInDoc(parseDoc(clozeDoc(1, 2, 3)))).toBeNull();
    expect(renumberClozesInDoc(parseDoc(clozeDoc()))).toBeNull();
  });

  it('keeps the text on each blank where it was', () => {
    const fixed = JSON.stringify(renumberClozesInDoc(parseDoc(clozeDoc(1, 1))));
    expect(fixed).toContain('blank 0');
    expect(fixed).toContain('blank 1');
  });

  it('reaches blanks nested inside a list', () => {
    const doc = parseDoc(
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'cloze', attrs: { index: 1, text: 'a' } },
                      { type: 'cloze', attrs: { index: 1, text: 'b' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      })
    );
    expect(orderedIndices(JSON.stringify(renumberClozesInDoc(doc)))).toEqual([1, 2]);
  });

  it('does not mutate the doc it was given', () => {
    const doc = parseDoc(clozeDoc(1, 1));
    const before = JSON.stringify(doc);
    renumberClozesInDoc(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('planClozeRepair', () => {
  function node(id: string, content?: string): OutlinerNode {
    return { ...createEmptyNode(), id, content: content ?? '', plainText: id } as OutlinerNode;
  }

  it('rewrites only the rems that need it', () => {
    const rows = [
      node('clean', clozeDoc(1, 2)),
      node('broken', clozeDoc(1, 1)),
      node('plain', JSON.stringify({ type: 'doc', content: [] })),
    ];
    const updates = planClozeRepair(rows);
    expect(updates.map((n) => n.id)).toEqual(['broken']);
    expect(indicesOf(updates[0]!.content)).toEqual([1, 2]);
  });

  it('is safe to run twice', () => {
    const rows = [node('broken', clozeDoc(1, 1, 2))];
    const once = planClozeRepair(rows);
    expect(planClozeRepair(once)).toEqual([]);
  });

  it('does not bump updatedAt', () => {
    const row = { ...node('broken', clozeDoc(1, 1)), updatedAt: 4242 } as OutlinerNode;
    expect(planClozeRepair([row])[0]?.updatedAt).toBe(4242);
  });

  it('copes with content that is not valid JSON', () => {
    const rows = [node('broken', '{"cloze": not json')];
    expect(() => planClozeRepair(rows)).not.toThrow();
    expect(planClozeRepair(rows)).toEqual([]);
  });

  it('leaves every rem with blanks that are all distinct', () => {
    const rows = [node('a', clozeDoc(1, 1, 1)), node('b', clozeDoc(2, 2, 3, 3))];
    for (const updated of planClozeRepair(rows)) {
      const all = orderedIndices(updated.content);
      expect(new Set(all).size).toBe(all.length);
    }
  });
});
