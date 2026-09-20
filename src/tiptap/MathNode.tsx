import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { katexIfLoaded, loadKatex, renderMath } from './katexLoader';

function MathView({ node, updateAttributes }: NodeViewProps) {
  const latex = String(node.attrs.latex ?? '');

  // Once KaTeX is in memory the markup is derived during render, so editing a
  // formula never round-trips through state. Only the very first formula in a
  // session waits, and it shows its own source in the meantime.
  const [katex, setKatex] = useState(katexIfLoaded);
  const html = katex ? renderMath(katex, latex) : latex;

  useEffect(() => {
    if (katex) return;
    let live = true;
    void loadKatex().then((loaded) => {
      if (live) setKatex(loaded);
    });
    return () => {
      live = false;
    };
  }, [katex]);

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
