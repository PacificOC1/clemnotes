import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { NodeViewProps } from '@tiptap/react';
import { maxClozeIndex, renumberedClozeIndices } from './docUtils';
import type { DocNode } from './docUtils';

/**
 * A `{{cloze}}` occlusion. Typing `{{some text}}` wraps that text in a numbered
 * blank; each distinct number becomes its own flashcard, so one sentence can
 * test several facts independently.
 *
 * The `state` attr is only ever set when the node is rendered inside a review
 * session — in the editor it stays undefined and the cloze just shows its text
 * with an underline. That keeps one node type serving both the editing view
 * and the two review views (blanked / revealed).
 */
function ClozeView({ node }: NodeViewProps) {
  const text = String(node.attrs.text ?? '');
  const index = Number(node.attrs.index ?? 1);
  const state = node.attrs.state as string | undefined;

  if (state === 'hidden') {
    return (
      <NodeViewWrapper as="span" className="cloze cloze-hidden" data-index={index}>
        [&nbsp;…&nbsp;]
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="span"
      className={`cloze ${state === 'revealed' ? 'cloze-revealed' : ''}`}
      data-index={index}
      title={`Cloze ${index}`}
    >
      {text}
    </NodeViewWrapper>
  );
}

export const Cloze = Node.create({
  name: 'cloze',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      index: { default: 1 },
      text: { default: '' },
      state: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-cloze]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-cloze': '' }), String(HTMLAttributes.text ?? '')];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ClozeView);
  },

  /**
   * Keep the blanks in a rem uniquely numbered as the rem is edited.
   *
   * This has to happen in the editor rather than on the way to the database.
   * A rem's editor deliberately ignores content changes while it has focus, so
   * that hydration never fights live typing — which means fixing the numbers in
   * the stored doc would leave the editor holding the colliding version and
   * writing it straight back on the next keystroke. Fixing it here means the
   * correction is part of the same edit that caused it, and travels through the
   * normal write path like anything else the user typed.
   */
  addProseMirrorPlugins() {
    const type = this.type;
    return [
      new Plugin({
        key: new PluginKey('clozeRenumber'),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;

          const positions: number[] = [];
          const indices: number[] = [];
          newState.doc.descendants((node, pos) => {
            if (node.type === type) {
              positions.push(pos);
              indices.push(Number(node.attrs.index ?? 1));
            }
          });

          const renumbered = renumberedClozeIndices(indices);
          if (!renumbered) return null;

          const tr = newState.tr;
          positions.forEach((pos, i) => {
            if (renumbered[i] !== indices[i]) tr.setNodeAttribute(pos, 'index', renumbered[i]);
          });
          // Not undoable on its own: the edit that caused the collision is the
          // thing worth stepping back through, not the repair.
          return tr.setMeta('addToHistory', false);
        },
      }),
    ];
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\{\{([^{}]+)\}\}$/,
        handler: ({ state, range, match }) => {
          const text = match[1]!.trim();
          if (!text) return;
          // Number this cloze one past the highest already in the rem, so
          // adding a second blank to a sentence creates a second card rather
          // than merging into the first.
          const next = maxClozeIndex(state.doc.toJSON() as DocNode) + 1;
          state.tr.replaceWith(range.from, range.to, this.type.create({ index: next, text }));
        },
      }),
    ];
  },
});
