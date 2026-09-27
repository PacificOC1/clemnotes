/**
 * Where a highlight sits on a PDF page (#53), as fractions of the page.
 *
 * A highlight is stored as rectangles in page coordinates between 0 and 1 —
 * not pixels — so it lands in the same place whatever the zoom, the window
 * width, or the device it is shown on.
 */

export interface PageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Screen rectangles (a text selection's client rects) as fractions of the page
 * box they sit on, clipped to it. Rects that miss the page, or have no area,
 * are dropped.
 */
export function toPageRects(rects: Box[], page: Box): PageRect[] {
  const out: PageRect[] = [];
  for (const rect of rects) {
    const left = Math.max(rect.left, page.left);
    const top = Math.max(rect.top, page.top);
    const right = Math.min(rect.left + rect.width, page.left + page.width);
    const bottom = Math.min(rect.top + rect.height, page.top + page.height);
    if (right - left < 0.5 || bottom - top < 0.5) continue;
    out.push({
      x: (left - page.left) / page.width,
      y: (top - page.top) / page.height,
      w: (right - left) / page.width,
      h: (bottom - top) / page.height,
    });
  }
  return mergeLines(out);
}

/**
 * One rectangle per line. A PDF's text layer is many small spans, so a
 * selection comes back as dozens of overlapping boxes; merging the ones that
 * share a line keeps the stored highlight small and its drawing clean.
 */
export function mergeLines(rects: PageRect[]): PageRect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: PageRect[] = [];
  for (const rect of sorted) {
    const line = lines.find((l) => {
      const overlap = Math.min(l.y + l.h, rect.y + rect.h) - Math.max(l.y, rect.y);
      return overlap > 0.5 * Math.min(l.h, rect.h);
    });
    if (!line) {
      lines.push({ ...rect });
      continue;
    }
    const right = Math.max(line.x + line.w, rect.x + rect.w);
    const bottom = Math.max(line.y + line.h, rect.y + rect.h);
    line.x = Math.min(line.x, rect.x);
    line.y = Math.min(line.y, rect.y);
    line.w = right - line.x;
    line.h = bottom - line.y;
  }
  return lines.map((r) => ({ x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) }));
}

/** Rects as stored on a page chip: compact, and safe to read back from anything. */
export function encodeRects(rects: PageRect[]): string {
  return JSON.stringify(rects.map((r) => [r.x, r.y, r.w, r.h]));
}

export function decodeRects(raw: unknown): PageRect[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is number[] => Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === 'number' && Number.isFinite(n)))
      .map(([x, y, w, h]) => ({ x: x!, y: y!, w: w!, h: h! }));
  } catch {
    return [];
  }
}

/** Selected PDF text as one line of prose: the text layer breaks it at every line end. */
export function cleanSelectionText(text: string): string {
  return text
    .replace(/-\n(?=\p{Ll})/gu, '') // a word hyphenated across a line break
    .replace(/\s+/g, ' ')
    .trim();
}
