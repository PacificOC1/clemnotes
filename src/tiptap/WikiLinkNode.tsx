import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getNode, searchNodesByTitle, createPage } from '../db/repository';
import { useNavigation } from '../context/NavigationContext';
import type { NodeViewProps } from '@tiptap/react';

/**
 * `[[Title]]`.
 *
 * A link stores two things: the id of the rem it points at, and the text it
 * was written as. The id is what the link *means*; the title is what it reads
 * as, and the fallback for links typed by hand or written before ids existed.
 *
 * Storing only the title — which is how this started — meant a link was really
 * a text match against every rem's `plainText`. Rename the target and the link
 * quietly stopped resolving; two rems with the same text were indistinguishable
 * to it. With an id, renaming the target is invisible to the link, and the
 * label follows the target's current text rather than a stale copy of it.
 */
function WikiLinkView({ node }: NodeViewProps) {
  const title = String(node.attrs.title ?? '');
  const targetId = node.attrs.targetId ? String(node.attrs.targetId) : null;
  const alias = node.attrs.alias ? String(node.attrs.alias) : '';
  const { onZoomTo } = useNavigation();

  // An id is one indexed lookup; a title is a scan, so only do that when the
  // link has no id to go on.
  const target = useLiveQuery(
    () => (targetId ? getNode(targetId) : Promise.resolve(undefined)),
    [targetId]
  );
  const matches =
    useLiveQuery(
      () => (targetId ? Promise.resolve([]) : searchNodesByTitle(title)),
      [targetId, title]
    ) ?? [];

  const live = target && !target.deletedAt ? target : undefined;
  const byTitle = matches.find(
    (n) => n.plainText.trim().toLowerCase() === title.trim().toLowerCase()
  );
  const resolved = live ?? byTitle;

  // An alias is the writer saying what this link should read as in *this*
  // sentence, so it outranks everything. Otherwise the target's current text,
  // so a rename shows up everywhere it is linked; and the stored title as the
  // last fallback, including for a target that has since been deleted —
  // better to still read as something than to go blank.
  const label = alias || live?.plainText.trim() || title || 'Untitled';

  async function handleClick() {
    if (resolved) {
      onZoomTo(resolved.id);
      return;
    }
    // Nothing to point at — create the page, Roam/RemNote-style.
    const page = await createPage(title);
    onZoomTo(page.id);
  }

  return (
    <NodeViewWrapper
      as="span"
      className={`wiki-link ${resolved ? '' : 'wiki-link-new'}`}
      onClick={handleClick}
      title={label !== title && title ? `Links to "${title}"` : undefined}
    >
      {label}
    </NodeViewWrapper>
  );
}

export const WikiLink = Node.create({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      title: { default: '' },
      /** `[[Photosynthesis|it]]` — what this link reads as, where that differs. */
      alias: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-alias'),
        renderHTML: (attributes) => (attributes.alias ? { 'data-alias': attributes.alias } : {}),
      },
      targetId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-target-id'),
        renderHTML: (attributes) =>
          attributes.targetId ? { 'data-target-id': attributes.targetId } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-wiki-link]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-wiki-link': '' }), HTMLAttributes.title];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WikiLinkView);
  },

  addInputRules() {
    return [
      new InputRule({
        // `[[Target]]` or `[[Target|as written]]`. A hand-typed link has no id:
        // there is nothing to resolve it against until it is written, so it
        // stays a title match until the picker or the migration gives it one.
        find: /\[\[([^[\]|]+)(?:\|([^[\]|]*))?\]\]$/,
        handler: ({ state, range, match }) => {
          const title = (match[1] ?? '').trim();
          if (!title) return;
          const alias = (match[2] ?? '').trim() || null;
          const { tr } = state;
          tr.replaceWith(range.from, range.to, this.type.create({ title, alias }));
        },
      }),
    ];
  },
});
