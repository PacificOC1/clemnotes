import type { DictionaryEntry } from '../db/schema';

/**
 * Finding dictionary words in text (#18).
 *
 * It used to loop over every defined word and `indexOf` it through every text
 * node, in every mounted editor, on every keystroke — words × text × editors.
 * Now the dictionary is compiled once, when it changes, into one alternation
 * regex with the longest words first (so "cell wall" wins over "cell"), and
 * each text node is scanned once.
 */

export interface DictionaryMatch {
  from: number;
  to: number;
  entry: DictionaryEntry;
}

export interface Matcher {
  find(text: string): DictionaryMatch[];
}

const EMPTY: Matcher = { find: () => [] };
const compiled = new WeakMap<Map<string, DictionaryEntry>, Matcher>();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compileMatcher(entries: Map<string, DictionaryEntry>): Matcher {
  const cached = compiled.get(entries);
  if (cached) return cached;
  const words = [...entries.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (words.length === 0) return EMPTY;

  // Whole words only: not preceded or followed by a letter, digit or `_`.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words.map(escape).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  const matcher: Matcher = {
    find(text) {
      const out: DictionaryMatch[] = [];
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const entry = entries.get(match[0].toLowerCase());
        if (entry) out.push({ from: match.index, to: match.index + match[0].length, entry });
      }
      return out;
    },
  };
  compiled.set(entries, matcher);
  return matcher;
}
