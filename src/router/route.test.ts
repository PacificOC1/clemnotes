import { describe, expect, it } from 'vitest';
import { HOME, formatRoute, parseRoute, sameRoute } from './route';

describe('parseRoute', () => {
  it('reads each tab', () => {
    expect(parseRoute('#/notes')).toEqual({ tab: 'notes', nodeId: null });
    expect(parseRoute('#/review')).toEqual({ tab: 'review', nodeId: null });
    expect(parseRoute('#/dictionary')).toEqual({ tab: 'dictionary', nodeId: null });
  });

  it('reads the zoomed rem', () => {
    expect(parseRoute('#/notes/abc-123')).toEqual({ tab: 'notes', nodeId: 'abc-123' });
  });

  it('decodes an escaped id', () => {
    expect(parseRoute('#/notes/a%2Fb')).toEqual({ tab: 'notes', nodeId: 'a/b' });
  });

  it('lands on the notes tab for anything it does not recognise', () => {
    // A mistyped URL should put you somewhere usable, not on an error.
    for (const hash of ['', '#', '#/', '#/nonsense', '#/nonsense/abc', 'notes', '#//']) {
      expect(parseRoute(hash)).toEqual(HOME);
    }
  });

  it('ignores a rem id on a tab that has no rems', () => {
    expect(parseRoute('#/review/abc')).toEqual({ tab: 'review', nodeId: null });
  });

  it('survives a malformed percent-escape', () => {
    expect(parseRoute('#/notes/%E0%A4%A')).toEqual(HOME);
  });

  it('tolerates stray slashes and whitespace', () => {
    expect(parseRoute('#//notes//abc//')).toEqual({ tab: 'notes', nodeId: 'abc' });
    expect(parseRoute('#/ notes / abc ')).toEqual({ tab: 'notes', nodeId: 'abc' });
  });
});

describe('formatRoute', () => {
  it('writes a canonical hash for every route', () => {
    expect(formatRoute({ tab: 'notes', nodeId: null })).toBe('#/notes');
    expect(formatRoute({ tab: 'notes', nodeId: 'abc' })).toBe('#/notes/abc');
    expect(formatRoute({ tab: 'review', nodeId: null })).toBe('#/review');
    expect(formatRoute({ tab: 'dictionary', nodeId: null })).toBe('#/dictionary');
  });

  it('drops a rem id that the tab cannot show', () => {
    expect(formatRoute({ tab: 'review', nodeId: 'abc' })).toBe('#/review');
  });

  it('escapes an id that would otherwise break the path', () => {
    expect(formatRoute({ tab: 'notes', nodeId: 'a/b' })).toBe('#/notes/a%2Fb');
  });

  it('round-trips everything parseRoute produces', () => {
    for (const hash of ['#/notes', '#/notes/abc-123', '#/review', '#/dictionary', '#/notes/a%2Fb']) {
      expect(formatRoute(parseRoute(hash))).toBe(hash);
    }
  });
});

describe('sameRoute', () => {
  it('compares both parts', () => {
    expect(sameRoute(HOME, { tab: 'notes', nodeId: null })).toBe(true);
    expect(sameRoute(HOME, { tab: 'review', nodeId: null })).toBe(false);
    expect(sameRoute({ tab: 'notes', nodeId: 'a' }, { tab: 'notes', nodeId: 'b' })).toBe(false);
  });
});
