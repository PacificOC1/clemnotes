import { describe, expect, it } from 'vitest';
import { buildTitleIndex, planLinkBackfill } from './linkBackfill';
import { attachLinkTargets, extractWikiLinks, parseDoc } from '../tiptap/docUtils';
import { createEmptyNode, type OutlinerNode } from './schema';

/** A doc of `[[…]]` links, each given as `[title, targetId]`. */
function linkDoc(...links: Array<[title: string, targetId?: string | null]>): string {
  return JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: links.map(([title, targetId]) => ({
          type: 'wikiLink',
          attrs: targetId === undefined ? { title } : { title, targetId },
        })),
      },
    ],
  });
}

function node(id: string, plainText: string, overrides: Partial<OutlinerNode> = {}): OutlinerNode {
  return { ...createEmptyNode(), id, plainText, ...overrides } as OutlinerNode;
}

const targetsOf = (content: string) => extractWikiLinks(parseDoc(content)).map((l) => l.targetId);

describe('extractWikiLinks', () => {
  it('reports the id and the title of each link', () => {
    expect(extractWikiLinks(parseDoc(linkDoc(['Calculus', 'rem-1'], ['Algebra'])))).toEqual([
      { targetId: 'rem-1', title: 'Calculus', alias: null },
      { targetId: null, title: 'Algebra', alias: null },
    ]);
  });

  it('treats an empty id as no id', () => {
    expect(extractWikiLinks(parseDoc(linkDoc(['Calculus', ''])))[0]?.targetId).toBeNull();
  });

  it('finds links nested anywhere in the doc', () => {
    const doc = {
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
                  content: [{ type: 'wikiLink', attrs: { title: 'Deep', targetId: 'x' } }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(extractWikiLinks(parseDoc(JSON.stringify(doc)))).toEqual([
      { targetId: 'x', title: 'Deep', alias: null },
    ]);
  });
});

describe('attachLinkTargets', () => {
  const resolve = (title: string) => (title === 'Calculus' ? 'rem-1' : undefined);

  it('fills in a missing id', () => {
    const next = attachLinkTargets(parseDoc(linkDoc(['Calculus'])), resolve);
    expect(next).not.toBeNull();
    expect(targetsOf(JSON.stringify(next))).toEqual(['rem-1']);
  });

  it('leaves an id that is already there', () => {
    // Re-pointing an existing link at whatever currently shares its text would
    // silently rewrite links the user made deliberately.
    expect(attachLinkTargets(parseDoc(linkDoc(['Calculus', 'chosen-by-hand'])), resolve)).toBeNull();
  });

  it('leaves a title that resolves to nothing', () => {
    expect(attachLinkTargets(parseDoc(linkDoc(['Nowhere'])), resolve)).toBeNull();
  });

  it('reports no change rather than an identical doc', () => {
    // The caller uses this to decide which rows to write at all.
    expect(attachLinkTargets(parseDoc(linkDoc(['Nowhere'], ['Elsewhere'])), resolve)).toBeNull();
  });

  it('fills some links and leaves others in the same doc', () => {
    const next = attachLinkTargets(parseDoc(linkDoc(['Calculus'], ['Nowhere'])), resolve);
    expect(targetsOf(JSON.stringify(next))).toEqual(['rem-1', null]);
  });

  it('does not mutate the doc it was given', () => {
    const doc = parseDoc(linkDoc(['Calculus']));
    const before = JSON.stringify(doc);
    attachLinkTargets(doc, resolve);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('reaches links nested inside lists', () => {
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
                  { type: 'paragraph', content: [{ type: 'wikiLink', attrs: { title: 'Calculus' } }] },
                ],
              },
            ],
          },
        ],
      })
    );
    expect(targetsOf(JSON.stringify(attachLinkTargets(doc, resolve)))).toEqual(['rem-1']);
  });
});

describe('buildTitleIndex', () => {
  it('matches case- and whitespace-insensitively', () => {
    const index = buildTitleIndex([node('a', '  Photosynthesis ')]);
    expect(index.get('photosynthesis')).toBe('a');
  });

  it('lets the first of two identical titles win', () => {
    // Which is exactly the ambiguity ids exist to remove — but while
    // backfilling, first-wins is the rule the old resolver used, so the
    // migration cannot change what an existing link pointed at.
    const index = buildTitleIndex([node('a', 'Twin'), node('b', 'Twin')]);
    expect(index.get('twin')).toBe('a');
  });

  it('ignores tombstones and untitled rems', () => {
    const index = buildTitleIndex([node('a', 'Gone', { deletedAt: 1 }), node('b', '   ')]);
    expect(index.size).toBe(0);
  });
});

describe('planLinkBackfill', () => {
  it('rewrites only the rows that needed it', () => {
    const rows = [
      node('target', 'Calculus'),
      node('links', 'see Calculus', { content: linkDoc(['Calculus']) }),
      node('plain', 'no links here'),
      node('already', 'x', { content: linkDoc(['Calculus', 'target']) }),
    ];
    const updates = planLinkBackfill(rows);
    expect(updates.map((n) => n.id)).toEqual(['links']);
    expect(targetsOf(updates[0]!.content)).toEqual(['target']);
  });

  it('is safe to run twice', () => {
    const rows = [node('target', 'Calculus'), node('links', 'x', { content: linkDoc(['Calculus']) })];
    const once = planLinkBackfill(rows);
    const applied = rows.map((r) => once.find((u) => u.id === r.id) ?? r);
    expect(planLinkBackfill(applied)).toEqual([]);
  });

  it('does not bump updatedAt', () => {
    // Filling in an id is a representation change, not an edit. Touching the
    // timestamp would make every device push its whole notebook on the next
    // sync and argue over notes nobody changed.
    const links = node('links', 'x', { content: linkDoc(['Calculus']), updatedAt: 1000 });
    const updates = planLinkBackfill([node('target', 'Calculus'), links]);
    expect(updates[0]?.updatedAt).toBe(1000);
  });

  it('never points a rem at itself', () => {
    const selfLink = node('self', 'Recursion', { content: linkDoc(['Recursion']) });
    expect(planLinkBackfill([selfLink])).toEqual([]);
  });

  it('leaves a link whose target does not exist', () => {
    const rows = [node('links', 'x', { content: linkDoc(['Nowhere']) })];
    expect(planLinkBackfill(rows)).toEqual([]);
  });

  it('will not resolve a link to a deleted rem', () => {
    const rows = [
      node('target', 'Calculus', { deletedAt: 1 }),
      node('links', 'x', { content: linkDoc(['Calculus']) }),
    ];
    expect(planLinkBackfill(rows)).toEqual([]);
  });

  it('copes with a row whose content is not valid JSON', () => {
    const rows = [
      node('target', 'Calculus'),
      node('broken', 'x', { content: '{ "wikiLink": not json' }),
    ];
    expect(() => planLinkBackfill(rows)).not.toThrow();
    expect(planLinkBackfill(rows)).toEqual([]);
  });
});
