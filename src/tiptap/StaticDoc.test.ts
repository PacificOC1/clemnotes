import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticDoc, docNeedsEditor } from './StaticDoc';
import { updateDictionaryStore } from '../db/dictionaryStore';
import type { DocNode } from './docUtils';
import type { DictionaryEntry } from '../db/schema';

const para = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content });
const text = (value: string, marks?: DocNode['marks']): DocNode => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const doc = (...content: DocNode[]): DocNode => ({ type: 'doc', content });
const render = (d: DocNode, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(StaticDoc, { doc: d, ...props }));

describe('drawing a rem without an editor (#19)', () => {
  it('knows which documents still need a real editor', () => {
    expect(docNeedsEditor(doc(para(text('plain'))))).toBe(false);
    expect(docNeedsEditor(doc({ type: 'remQuery', attrs: { query: '{}' } }))).toBe(true);
    expect(docNeedsEditor(doc(para({ type: 'somethingNew' })))).toBe(true);
  });

  it('uses the tags the editor produces, marks nested as ProseMirror nests them', () => {
    const html = render(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
        para(text('bold ', [{ type: 'bold' }]), text('link', [{ type: 'link', attrs: { href: 'https://example.com' } }]), text(' code', [{ type: 'code' }]))
      )
    );
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<strong>bold </strong>');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">link</a>');
    expect(html).toContain('<code> code</code>');
    expect(html).toMatch(/^<div class="tiptap ProseMirror rem-static/);
  });

  it('shows the placeholder in an empty rem, and keeps an empty paragraph after a heading', () => {
    expect(render(doc(para()), { placeholder: 'Type' })).toContain('class="is-empty is-editor-empty" data-placeholder="Type"');
    const heading = render(doc({ type: 'heading', attrs: { level: 1 }, content: [text('H')] }), { trailingParagraph: true });
    expect(heading).toMatch(/<\/h1><p><br class="ProseMirror-trailingBreak"\/><\/p>/);
  });

  it('underlines dictionary words, but not inside code', () => {
    const entry: DictionaryEntry = { id: 'e1', word: 'osmosis', displayWord: 'Osmosis', definition: 'water moving', deletedAt: null, createdAt: 0, updatedAt: 0 };
    updateDictionaryStore(new Map([['osmosis', entry]]), () => {});
    const html = render(doc(para(text('Osmosis happens; '), text('osmosis', [{ type: 'code' }]))), { dictionary: true });
    expect(html).toContain('class="dict-word" data-entry-id="e1"');
    expect(html.match(/dict-word/g)).toHaveLength(1);
    updateDictionaryStore(new Map(), () => {});
  });

  it('draws clozes and task items as the editor does', () => {
    const html = render(
      doc(
        para(text('The '), { type: 'cloze', attrs: { index: 2, text: 'mitochondria' } }),
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [para(text('done'))] }] }
      )
    );
    expect(html).toContain('class="cloze " data-index="2" title="Cloze 2"');
    expect(html).toContain('<li data-checked="true" data-type="taskItem"><label><input type="checkbox" readOnly=""');
    expect(html).toContain('aria-label="Task item checkbox for done"');
  });
});
