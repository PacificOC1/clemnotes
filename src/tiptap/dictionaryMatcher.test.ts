import { describe, expect, it } from 'vitest';
import { compileMatcher } from './dictionaryMatcher';
import type { DictionaryEntry } from '../db/schema';

const entry = (word: string): DictionaryEntry => ({
  id: word,
  word: word.toLowerCase(),
  displayWord: word,
  definition: `def of ${word}`,
  deletedAt: null,
  createdAt: 0,
  updatedAt: 0,
});
const dict = (...words: string[]) => new Map(words.map((w) => [w.toLowerCase(), entry(w)]));

describe('dictionary matcher', () => {
  it('finds whole words in any case, longest first', () => {
    const found = compileMatcher(dict('cell', 'cell wall', 'ATP')).find('The Cell wall and atp, not cellular.');
    expect(found.map((m) => [m.entry.id, m.from, m.to])).toEqual([
      ['cell wall', 4, 13],
      ['ATP', 18, 21],
    ]);
  });

  it('copes with words that are regex syntax', () => {
    expect(compileMatcher(dict('C++', 'a.b')).find('I like C++ and a.b but not axb').map((m) => m.entry.id)).toEqual(['C++', 'a.b']);
  });

  it('compiles once per dictionary', () => {
    const d = dict('x');
    expect(compileMatcher(d)).toBe(compileMatcher(d));
    expect(compileMatcher(new Map()).find('anything')).toEqual([]);
  });
});
