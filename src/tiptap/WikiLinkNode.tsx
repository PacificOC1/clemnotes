import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { searchNodesByTitle, createPage } from '../db/repository';
import { useNavigation } from '../context/NavigationContext';
import type { NodeViewProps } from '@tiptap/react';

function WikiLinkView({ node }: NodeViewProps) {
  const title = String(node.attrs.title ?? '');
  const { onZoomTo } = useNavigation();

  const matches = useLiveQuery(() => searchNodesByTitle(title), [title]) ?? [];
  const exact = matches.find((n) => n.plainText.trim().toLowerCase() === title.trim().toLowerCase());

  async function handleClick() {
    if (exact) {
      onZoomTo(exact.id);
    } else {
      // No existing node with this title — create a new page for it, Roam/RemNote-style.
      const page = await createPage(title);
      onZoomTo(page.id);
    }
  }

  return (
    <NodeViewWrapper as="span" className={`wiki-link ${exact ? '' : 'wiki-link-new'}`} onClick={handleClick}>
      {title}
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
        find: /\[\[([^[\]]+)\]\]$/,
        handler: ({ state, range, match }) => {
          const title = match[1].trim();
          if (!title) return;
          const { tr } = state;
          tr.replaceWith(range.from, range.to, this.type.create({ title }));
        },
      }),
    ];
  },
});
