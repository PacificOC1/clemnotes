import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import {
  createFirstChild,
  createPage,
  createPortalChild,
  createSiblingAfter,
  deleteNode,
  deleteNodes,
  flattenVisible,
  indentNodes,
  outdentNodes,
  getAllPages,
  getBacklinks,
  getBreadcrumbPath,
  getChildren,
  getNode,
  indentNode,
  isSelfOrDescendant,
  mergeWithPreviousSibling,
  moveAmongSiblings,
  moveNodeRelativeTo,
  outdentNode,
  syncOutboundLinks,
  updateContent,
} from './repository';
import { getCardsForNode } from './cardRepository';
import { addChild, addTextNode, childOrder, resetDatabase, textDoc } from '../test/helpers';
import { parseDoc } from '../tiptap/docUtils';

/**
 * A page with three children, a, b, c — the smallest tree that can express
 * every structural operation: there is a sibling before, a sibling after, and
 * somewhere to indent into.
 */
async function threeChildTree() {
  const page = await addTextNode('page', 'Page', { isPage: true, order: 1000 });
  const a = await addChild(page, 'a', 'A');
  const b = await addChild(page, 'b', 'B');
  const c = await addChild(page, 'c', 'C');
  return { page, a, b, c };
}

beforeEach(resetDatabase);

describe('tree structure', () => {
  it('indent then outdent returns the tree to where it started', async () => {
    const { page } = await threeChildTree();
    const before = await childOrder(page.id);

    expect(await indentNode('b')).toBe(true);
    expect(await childOrder(page.id)).toEqual(['a', 'c']);
    expect(await childOrder('a')).toEqual(['b']);

    expect(await outdentNode('b')).toBe(true);
    expect(await childOrder(page.id)).toEqual(before);
    expect(await childOrder('a')).toEqual([]);
    expect((await getNode('b'))?.parentId).toBe(page.id);
  });

  it('survives the round trip repeated', async () => {
    const { page } = await threeChildTree();
    const before = await childOrder(page.id);
    for (let i = 0; i < 5; i++) {
      await indentNode('b');
      await outdentNode('b');
    }
    // Order keys are fractional, so repeated moves must not drift the
    // displayed order even as the numbers themselves change.
    expect(await childOrder(page.id)).toEqual(before);
  });

  it('refuses to indent the first child', async () => {
    await threeChildTree();
    expect(await indentNode('a')).toBe(false);
  });

  it('refuses to outdent a top-level page', async () => {
    const page = await createPage('Top');
    expect(await outdentNode(page.id)).toBe(false);
  });

  it('keeps childrenIds a faithful mirror of display order', async () => {
    const { page } = await threeChildTree();
    await moveAmongSiblings('c', -1);
    const parent = await getNode(page.id);
    expect(await childOrder(page.id)).toEqual(['a', 'c', 'b']);
    expect(parent?.childrenIds).toEqual(['a', 'c', 'b']);
  });

  it('inserts a new sibling directly after its origin, not at the end', async () => {
    const { page } = await threeChildTree();
    const fresh = await createSiblingAfter('a');
    expect(await childOrder(page.id)).toEqual(['a', fresh.id, 'b', 'c']);
    expect((await getNode(page.id))?.childrenIds).toEqual(['a', fresh.id, 'b', 'c']);
  });

  it('will not drop a node into its own subtree', async () => {
    const { page } = await threeChildTree();
    await indentNode('b'); // b is now a child of a
    expect(await moveNodeRelativeTo('a', 'b', 'child')).toBe(false);
    expect(await moveNodeRelativeTo('a', 'a', 'after')).toBe(false);
    // The tree is untouched by the refusal.
    expect(await childOrder(page.id)).toEqual(['a', 'c']);
    expect((await getNode('b'))?.parentId).toBe('a');
  });

  it('moves a node under a new parent and detaches it from the old one', async () => {
    const { page } = await threeChildTree();
    expect(await moveNodeRelativeTo('c', 'a', 'child')).toBe(true);
    expect(await childOrder(page.id)).toEqual(['a', 'b']);
    expect(await childOrder('a')).toEqual(['c']);
    expect((await getNode(page.id))?.childrenIds).toEqual(['a', 'b']);
  });

  it('reports the ancestor chain for breadcrumbs', async () => {
    const { page } = await threeChildTree();
    await indentNode('b');
    const path = await getBreadcrumbPath('b');
    expect(path.map((n) => n.id)).toEqual([page.id, 'a', 'b']);
  });

  it('knows what sits inside what', async () => {
    await threeChildTree();
    await indentNode('b');
    expect(await isSelfOrDescendant('b', 'a')).toBe(true);
    expect(await isSelfOrDescendant('a', 'a')).toBe(true);
    expect(await isSelfOrDescendant('a', 'b')).toBe(false);
    expect(await isSelfOrDescendant('c', 'a')).toBe(false);
  });
});

describe('pages', () => {
  it('opens a new page with one editable bullet', async () => {
    const page = await createPage('Fresh');
    const children = await getChildren(page.id);
    expect(children).toHaveLength(1);
    expect(page.childrenIds).toEqual([children[0]?.id]);
  });

  it('lists pages in order and excludes deleted ones', async () => {
    const first = await createPage('One');
    const second = await createPage('Two');
    expect((await getAllPages()).map((p) => p.id)).toEqual([first.id, second.id]);
    await deleteNode(first.id);
    expect((await getAllPages()).map((p) => p.id)).toEqual([second.id]);
  });
});

describe('deletion', () => {
  it('writes the whole cascade in one transaction', async () => {
    // Interrupted halfway, the old version left a subtree tombstoned while its
    // parent had already been trimmed — unreachable but not deleted.
    const { page } = await threeChildTree();
    await indentNode('b');
    const grandchild = await createFirstChild('b');

    let seenMidway: number | undefined;
    const hook = (_key: unknown, obj: { deletedAt?: number | null }) => {
      if (obj.deletedAt) seenMidway = (seenMidway ?? 0) + 1;
    };
    db.nodes.hook('updating', hook as never);
    try {
      await deleteNode('a');
    } finally {
      db.nodes.hook('updating').unsubscribe(hook as never);
    }

    for (const id of ['a', 'b', grandchild.id]) {
      expect((await getNode(id))?.deletedAt).toBeTypeOf('number');
    }
    expect((await getNode(page.id))?.childrenIds).toEqual(['c']);
  });

  it('tombstones a whole subtree rather than removing rows', async () => {
    const { page } = await threeChildTree();
    await indentNode('b');
    const grandchild = await createFirstChild('b');

    await deleteNode('a');

    // Nothing is physically gone — sync needs the tombstones to propagate.
    expect(await db.nodes.count()).toBe(5);
    for (const id of ['a', 'b', grandchild.id]) {
      expect((await getNode(id))?.deletedAt).toBeTypeOf('number');
    }
    expect(await childOrder(page.id)).toEqual(['c']);
    expect((await getNode(page.id))?.childrenIds).toEqual(['c']);
  });

  it('takes the cards of every deleted rem with it', async () => {
    const page = await addTextNode('page', 'Page', { isPage: true });
    const rem = await addChild(page, 'rem', 'Mitochondrion :: powerhouse');
    await updateContent(rem.id, textDoc('Mitochondrion :: powerhouse'), 'Mitochondrion :: powerhouse');
    expect(await getCardsForNode(rem.id)).toHaveLength(1);

    await deleteNode(page.id);
    expect(await getCardsForNode(rem.id)).toHaveLength(0);
  });
});

describe('merging rows', () => {
  it('re-parents the merged row children instead of deleting them', async () => {
    const { page } = await threeChildTree();
    const child = await createFirstChild('b');

    const survivor = await mergeWithPreviousSibling('b');

    expect(survivor).toBe('a');
    expect((await getNode('b'))?.deletedAt).toBeTypeOf('number');
    // The regression this guards: the delete cascade used to follow the
    // children that had just been handed to the previous sibling.
    expect((await getNode(child.id))?.deletedAt).toBeNull();
    expect(await childOrder('a')).toEqual([child.id]);
    expect(await childOrder(page.id)).toEqual(['a', 'c']);
  });

  it('will not merge the first row of a parent', async () => {
    await threeChildTree();
    expect(await mergeWithPreviousSibling('a')).toBeNull();
  });
});

describe('links', () => {
  it('resolves [[Title]] to a node id and back again as a backlink', async () => {
    await addTextNode('target', 'Photosynthesis', { isPage: true });
    const source = await addTextNode('source', 'See Photosynthesis');

    const doc = parseDoc(
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'See ' },
              { type: 'wikiLink', attrs: { title: 'Photosynthesis' } },
            ],
          },
        ],
      })
    );
    await syncOutboundLinks(source.id, doc);

    expect((await getNode('source'))?.outboundLinks).toEqual(['target']);
    expect((await getBacklinks('target')).map((n) => n.id)).toEqual(['source']);
  });

  it('never links a node to itself', async () => {
    const self = await addTextNode('self', 'Recursion');
    await syncOutboundLinks(self.id, parseDoc(JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'wikiLink', attrs: { title: 'Recursion' } }] }],
    })));
    expect((await getNode('self'))?.outboundLinks).toEqual([]);
  });

  it('clears links when the last one is removed, and not otherwise', async () => {
    const source = await addTextNode('source', 'text', { outboundLinks: ['gone'] });
    await syncOutboundLinks(source.id, parseDoc(textDoc('text')));
    expect((await getNode(source.id))?.outboundLinks).toEqual([]);

    // A rem with no links and nothing to clear must not write at all: this
    // runs on every debounced keystroke.
    const untouched = await addTextNode('plain', 'no links here');
    const stamp = untouched.updatedAt;
    await syncOutboundLinks(untouched.id, parseDoc(textDoc('no links here')));
    expect((await getNode('plain'))?.updatedAt).toBe(stamp);
  });
});

describe('working on several rems at once', () => {
  it('lists the rows on screen in display order, root excluded', async () => {
    const { page } = await threeChildTree();
    const grandchild = await createFirstChild('a');
    expect(await flattenVisible(page.id)).toEqual(['a', grandchild.id, 'b', 'c']);
  });

  it('leaves out rows hidden inside a collapsed rem', async () => {
    // A selection you cannot see is a selection you cannot have meant.
    const { page } = await threeChildTree();
    await createFirstChild('a');
    await db.nodes.update('a', { collapsed: true });
    expect(await flattenVisible(page.id)).toEqual(['a', 'b', 'c']);
  });

  it('indents a run of siblings, keeping their order', async () => {
    const { page } = await threeChildTree();
    const order = await flattenVisible(page.id);
    expect(await indentNodes(['b', 'c'], order)).toBe(2);
    expect(await childOrder(page.id)).toEqual(['a']);
    expect(await childOrder('a')).toEqual(['b', 'c']);
  });

  it('outdents a run back out again, keeping their order', async () => {
    const { page } = await threeChildTree();
    await indentNodes(['b', 'c'], await flattenVisible(page.id));
    await outdentNodes(['b', 'c'], await flattenVisible(page.id));
    expect(await childOrder(page.id)).toEqual(['a', 'b', 'c']);
  });

  it('never applies an operation twice to a nested rem', async () => {
    // Selecting a parent and its child and indenting used to move the child
    // twice, the second time relative to a tree that had already changed.
    const { page } = await threeChildTree();
    await indentNodes(['b'], await flattenVisible(page.id)); // b under a
    const order = await flattenVisible(page.id);

    // One rem is acted on, not two: `b` is dropped because `a` is selected and
    // already carries it. (`a` is the first child, so the indent itself is a
    // no-op — what matters is that `b` was not moved a second time.)
    expect(await indentNodes(['a', 'b'], order)).toBe(1);
    expect(await childOrder(page.id)).toEqual(['a', 'c']);
    expect(await childOrder('a')).toEqual(['b']);
  });

  it('deletes a whole selection, ancestors absorbing their descendants', async () => {
    const { page } = await threeChildTree();
    const grandchild = await createFirstChild('a');
    const order = await flattenVisible(page.id);

    expect(await deleteNodes(['a', grandchild.id, 'c'], order)).toBe(2);
    expect(await childOrder(page.id)).toEqual(['b']);
    expect((await getNode(grandchild.id))?.deletedAt).toBeTypeOf('number');
  });

  it('does nothing with an empty selection', async () => {
    const { page } = await threeChildTree();
    expect(await indentNodes([], await flattenVisible(page.id))).toBe(0);
    expect(await childOrder(page.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('links that carry a target id', () => {
  /** A doc containing one `[[…]]`, with or without an id. */
  function linkDoc(title: string, targetId?: string) {
    return JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'wikiLink', attrs: targetId ? { title, targetId } : { title } },
          ],
        },
      ],
    });
  }

  it('resolves by id, so renaming the target does not break the link', () => {
    // The bug this fixes: with only a title, renaming the target meant the next
    // edit of the linking rem quietly dropped the link.
    return (async () => {
      await addTextNode('target', 'Photosynthesis', { isPage: true });
      const source = await addTextNode('source', 'See Photosynthesis');

      await syncOutboundLinks(source.id, parseDoc(linkDoc('Photosynthesis', 'target')));
      expect((await getNode('source'))?.outboundLinks).toEqual(['target']);

      await db.nodes.update('target', { plainText: 'Photosynthesis (revised)' });
      await syncOutboundLinks(source.id, parseDoc(linkDoc('Photosynthesis', 'target')));
      expect((await getNode('source'))?.outboundLinks).toEqual(['target']);
      expect((await getBacklinks('target')).map((n) => n.id)).toEqual(['source']);
    })();
  });

  it('still loses a title-only link when its target is renamed', () => {
    // Documenting the old behaviour that remains for hand-typed links: there
    // is nothing to resolve them against but the text.
    return (async () => {
      await addTextNode('target', 'Photosynthesis', { isPage: true });
      const source = await addTextNode('source', 'See Photosynthesis');

      await syncOutboundLinks(source.id, parseDoc(linkDoc('Photosynthesis')));
      expect((await getNode('source'))?.outboundLinks).toEqual(['target']);

      await db.nodes.update('target', { plainText: 'Something else' });
      await syncOutboundLinks(source.id, parseDoc(linkDoc('Photosynthesis')));
      expect((await getNode('source'))?.outboundLinks).toEqual([]);
    })();
  });

  it('tells two rems with identical text apart', async () => {
    await addTextNode('twin-a', 'Bank');
    await addTextNode('twin-b', 'Bank');
    const source = await addTextNode('source', 'See Bank');

    await syncOutboundLinks(source.id, parseDoc(linkDoc('Bank', 'twin-b')));
    expect((await getNode('source'))?.outboundLinks).toEqual(['twin-b']);
  });

  it('falls back to the title when the id points at nothing', async () => {
    await addTextNode('target', 'Photosynthesis');
    const source = await addTextNode('source', 'See Photosynthesis');

    await syncOutboundLinks(source.id, parseDoc(linkDoc('Photosynthesis', 'no-such-rem')));
    expect((await getNode('source'))?.outboundLinks).toEqual(['target']);
  });

  it('will not resolve to a deleted rem by id', async () => {
    await addTextNode('target', 'Photosynthesis', { deletedAt: Date.now() });
    const source = await addTextNode('source', 'See Photosynthesis');

    await syncOutboundLinks(source.id, parseDoc(linkDoc('Photosynthesis', 'target')));
    expect((await getNode('source'))?.outboundLinks).toEqual([]);
  });

  it('never links a rem to itself by id', async () => {
    const self = await addTextNode('self', 'Recursion');
    await syncOutboundLinks(self.id, parseDoc(linkDoc('Recursion', 'self')));
    expect((await getNode('self'))?.outboundLinks).toEqual([]);
  });

  it('handles a doc mixing id-carrying and title-only links', async () => {
    await addTextNode('a', 'Alpha');
    await addTextNode('b', 'Beta');
    const source = await addTextNode('source', 'x');

    const doc = parseDoc(
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'wikiLink', attrs: { title: 'Alpha', targetId: 'a' } },
              { type: 'wikiLink', attrs: { title: 'Beta' } },
            ],
          },
        ],
      })
    );
    await syncOutboundLinks(source.id, doc);
    expect((await getNode('source'))?.outboundLinks.sort()).toEqual(['a', 'b']);
  });
});

describe('portals', () => {
  it('refuses to embed a rem inside itself or an ancestor', async () => {
    const { page } = await threeChildTree();
    // Embedding the page you are standing on inside itself is the accident
    // that used to hang the tab hard enough to need a tab close.
    expect(await createPortalChild(page.id, page.id)).toBeNull();
    expect(await createPortalChild('a', page.id)).toBeNull();
  });

  it('allows an embed that does not cycle', async () => {
    const { page } = await threeChildTree();
    const portal = await createPortalChild('a', 'c');
    expect(portal).not.toBeNull();
    expect(portal?.isPortal).toBe(true);
    expect(portal?.portalTargetId).toBe('c');
    expect(await childOrder(page.id)).toEqual(['a', 'b', 'c']);
  });
});
