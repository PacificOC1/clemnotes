import { describe, expect, it } from 'vitest';
import { docToPlainText, extractWikiLinks, parseDoc } from './docUtils';
import { docToMarkdown } from '../export/markdown';

/** One `[[…]]`, optionally with an alias, inside a sentence. */
function sentence(attrs: Record<string, unknown>) {
  return parseDoc(
    JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Plants do ' },
            { type: 'wikiLink', attrs },
            { type: 'text', text: ' all day.' },
          ],
        },
      ],
    })
  );
}

describe('link aliases', () => {
  it('are reported alongside the title and target', () => {
    expect(extractWikiLinks(sentence({ title: 'Photosynthesis', alias: 'it', targetId: 'p1' }))).toEqual([
      { targetId: 'p1', title: 'Photosynthesis', alias: 'it' },
    ]);
  });

  it('are null when there is none', () => {
    expect(extractWikiLinks(sentence({ title: 'Photosynthesis' }))[0]?.alias).toBeNull();
    expect(extractWikiLinks(sentence({ title: 'Photosynthesis', alias: '' }))[0]?.alias).toBeNull();
  });

  it('are what the rem reads as in plain text', () => {
    // Which matters more than it looks: plainText is what search, titles and
    // card faces use, and the sentence genuinely says "it".
    expect(docToPlainText(sentence({ title: 'Photosynthesis', alias: 'it' }))).toBe(
      'Plants do it all day.'
    );
  });

  it('fall back to the title when absent', () => {
    expect(docToPlainText(sentence({ title: 'Photosynthesis' }))).toBe(
      'Plants do Photosynthesis all day.'
    );
  });

  it('survive a Markdown export in re-creatable form', () => {
    expect(docToMarkdown(sentence({ title: 'Photosynthesis', alias: 'it' }))).toContain(
      '[[Photosynthesis|it]]'
    );
    expect(docToMarkdown(sentence({ title: 'Photosynthesis' }))).toContain('[[Photosynthesis]]');
  });

  it('keep the link pointing at the target, not at the alias', () => {
    const [link] = extractWikiLinks(sentence({ title: 'Photosynthesis', alias: 'it' }));
    expect(link?.title).toBe('Photosynthesis');
    expect(link?.targetId).toBeNull();
  });
});
