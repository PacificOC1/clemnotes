import { describe, expect, it } from 'vitest';
import { deriveTitle } from './titles';

describe('deriveTitle', () => {
  it('capitalises and cuts a long dot point at its first clause break', () => {
    expect(
      deriveTitle('the definitions of elements, isotopes and ions, including appropriate notation: atomic number; mass number')
    ).toBe('The definitions of elements, isotopes and ions');
    expect(deriveTitle('shapes of molecules (linear, bent, pyramidal) as determined by VSEPR')).toBe('Shapes of molecules');
  });

  it("doesn't cut so early the title means nothing", () => {
    expect(deriveTitle('pH: the scale')).toBe('PH: the scale');
    expect(deriveTitle('the use of a logbook to authenticate generated primary data')).toBe(
      'The use of a logbook to authenticate generated primary data'
    );
  });

  it('shortens at a word boundary with an ellipsis', () => {
    const t = deriveTitle('a very long learning point without any natural break in it that goes on and on and on for ages');
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.endsWith('…')).toBe(true);
    expect(t).toMatch(/^A very long/);
  });

  it('copes with empty text', () => {
    expect(deriveTitle('  ')).toBe('Untitled');
  });
});
