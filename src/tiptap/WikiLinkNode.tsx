import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { findByTitle, getNode } from '../db/repository';
import { createPageForTitle } from '../db/dailyNotes';
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
/**
 * Everything a link shows and does, from its attributes alone — shared by the
 * editor's node view and the static rendering a rem uses until you click into
 * it (#19), so the two can't drift apart.
 */
export function useWikiLinkView(attrs: Record<string, unknown> | undefined) {
  const title = String(attrs?.title ?? '');
  const targetId = attrs?.targetId ? String(attrs.targetId) : null;
  const alias = attrs?.alias ? String(attrs.alias) : '';
  const { onZoomTo, onOpenInSplit } = useNavigation();

  // An id is one indexed lookup; a title goes through the title index, and
  // only when the link has no id to go on.
  const target = useLiveQuery(
    () => (targetId ? getNode(targetId) : Promise.resolve(undefined)),
    [targetId]
  );
  const byTitle = useLiveQuery(
    () => (targetId || !title ? Promise.resolve(undefined) : findByTitle(title)),
    [targetId, title]
  );

  const live = target && !target.deletedAt ? target : undefined;
  const resolved = live ?? byTitle;

  // An alias is the writer saying what this link should read as in *this*
  // sentence, so it outranks everything. Otherwise the target's current text,
  // so a rename shows up everywhere it is linked; and the stored title as the
  // last fallback, including for a target that has since been deleted —
  // better to still read as something than to go blank.
  const label = alias || live?.plainText.trim() || title || 'Untitled';

  async function onClick(event: React.MouseEvent) {
    // Shift-click opens the link beside this document rather than in place of it.
    const go = event.shiftKey && onOpenInSplit ? onOpenInSplit : onZoomTo;
    if (resolved) {
      go(resolved.id);
      return;
    }
    // Nothing to point at — create the page, Roam/RemNote-style. A date makes
    // (or finds) that day's daily note rather than a loose page of the same name.
    go(await createPageForTitle(title));
  }

  return {
    label,
    className: `wiki-link ${resolved ? '' : 'wiki-link-new'}`,
    title: `${label !== title && title ? `Links to "${title}" · ` : ''}Shift-click to open beside`,
    onClick: (event: React.MouseEvent) => void onClick(event),
  };
}

function WikiLinkView({ node }: NodeViewProps) {
  const view = useWikiLinkView(node.attrs);
  return (
    <NodeViewWrapper as="span" className={view.className} onClick={view.onClick} title={view.title}>
      {view.label}
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
