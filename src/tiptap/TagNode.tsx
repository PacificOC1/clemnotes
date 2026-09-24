import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { NodeViewProps } from '@tiptap/react';
import { getNode } from '../db/repository';
import { ensureTagPage } from '../db/tags';
import { useNavigation } from '../context/NavigationContext';

/**
 * `#tag` — "this rem is about that".
 *
 * Stored like a link, as the id of the tag's page plus the name it was written
 * as, so renaming the tag page renames the tag everywhere it is used. Drawn as
 * a chip rather than an underlined link, because it says something different:
 * a link is part of the sentence, a tag is a label on it.
 */
/** What a tag shows and does — shared with the static rendering (#19). */
export function useTagView(attrs: Record<string, unknown> | undefined) {
  const title = String(attrs?.title ?? '');
  const targetId = attrs?.targetId ? String(attrs.targetId) : null;
  const { onZoomTo } = useNavigation();

  const target = useLiveQuery(
    () => (targetId ? getNode(targetId) : Promise.resolve(undefined)),
    [targetId]
  );
  const live = target && !target.deletedAt ? target : undefined;
  const label = live?.plainText.trim() || title || 'tag';

  async function handleClick() {
    onZoomTo(live ? live.id : await ensureTagPage(title));
  }

  return {
    label: `#${label}`,
    className: `tag-chip ${live ? '' : 'tag-chip-new'}`,
    onClick: () => void handleClick(),
  };
}

function TagView({ node }: NodeViewProps) {
  const view = useTagView(node.attrs);
  return (
    <NodeViewWrapper as="span" className={view.className} onClick={view.onClick}>
      {view.label}
    </NodeViewWrapper>
  );
}

export const Tag = Node.create({
  name: 'tag',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      title: { default: '' },
      targetId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-target-id'),
        renderHTML: (attributes) =>
          attributes.targetId ? { 'data-target-id': attributes.targetId } : {},
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-tag]',
        getAttrs: (element) => ({ title: (element as HTMLElement).getAttribute('data-tag') ?? '' }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-tag': node.attrs.title }),
      `#${node.attrs.title}`,
    ];
  },

  renderText({ node }) {
    return `#${node.attrs.title}`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(TagView);
  },
});
