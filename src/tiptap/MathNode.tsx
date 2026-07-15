import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useMemo } from 'react';

function MathView({ node, updateAttributes }: NodeViewProps) {
  const latex = String(node.attrs.latex ?? '');

  const html = useMemo(() => {
    try {
      return katex.renderToString(latex, { throwOnError: false, displayMode: false });
    } catch {
      return latex;
    }
  }, [latex]);

  function handleClick() {
    const next = window.prompt('Edit LaTeX:', latex);
    if (next !== null && next.trim() !== '') {
      updateAttributes({ latex: next.trim() });
    }
  }

  return (
    <NodeViewWrapper
      as="span"
      className="math-node"
      onClick={handleClick}
      title="Click to edit"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export const Math = Node.create({
  name: 'math',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      latex: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-math]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-math': '' }), String(HTMLAttributes.latex ?? '')];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathView);
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\$([^$]+)\$$/,
        handler: ({ state, range, match }) => {
          const latex = match[1].trim();
          if (!latex) return;
          const { tr } = state;
          tr.replaceWith(range.from, range.to, this.type.create({ latex }));
        },
      }),
    ];
  },
});
