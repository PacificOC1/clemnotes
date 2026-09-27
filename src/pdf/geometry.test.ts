import { describe, expect, it } from 'vitest';
import { cleanSelectionText, decodeRects, encodeRects, mergeLines, toPageRects } from './geometry';

describe('highlight geometry (#53)', () => {
  const page = { left: 100, top: 50, width: 600, height: 800 };

  it('turns screen rects into page fractions, one per line, clipped to the page', () => {
    const rects = toPageRects(
      [
        { left: 160, top: 130, width: 100, height: 16 },
        { left: 255, top: 131, width: 200, height: 15 }, // same line, overlapping span
        { left: 160, top: 150, width: 300, height: 16 }, // next line
        { left: 650, top: 170, width: 200, height: 16 }, // runs off the right edge
        { left: 900, top: 900, width: 10, height: 10 }, // off the page altogether
      ],
      page
    );
    expect(rects).toHaveLength(3);
    expect(rects[0]).toEqual({ x: 0.1, y: 0.1, w: 0.4917, h: 0.02 });
    expect(rects[2]!.x + rects[2]!.w).toBeCloseTo(1, 4);
  });

  it('keeps rects that share no line apart', () => {
    expect(mergeLines([{ x: 0, y: 0, w: 0.1, h: 0.02 }, { x: 0, y: 0.05, w: 0.1, h: 0.02 }])).toHaveLength(2);
  });

  it('round-trips rects through the stored form, and ignores rubbish', () => {
    const rects = [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }];
    expect(decodeRects(encodeRects(rects))).toEqual(rects);
    expect(decodeRects('not json')).toEqual([]);
    expect(decodeRects('[[1,2,3]]')).toEqual([]);
    expect(decodeRects(null)).toEqual([]);
  });

  it('joins a selection back into prose', () => {
    expect(cleanSelectionText('The mito-\nchondria is the\n  powerhouse  ')).toBe('The mitochondria is the powerhouse');
    expect(cleanSelectionText('Well-\nKnown')).toBe('Well- Known');
  });
});
