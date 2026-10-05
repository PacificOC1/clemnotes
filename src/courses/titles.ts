/**
 * Short titles for a course's units, areas of study and learning points.
 *
 * The study design's own wording is long: units and areas are questions, and
 * a dot point can run to fifty words starting with a lower-case "the". The
 * browser shows a short title first and the official wording underneath.
 * Short titles come from the catalogue (units and areas) and the study-notes
 * pack's labels (learning points); anything without one gets a title cut
 * from its own wording.
 */

/** "the definitions of elements, isotopes and ions, including …" → "The definitions of elements, isotopes and ions" */
export function deriveTitle(text: string, max = 60): string {
  let t = text.trim().replace(/\s+/g, ' ');
  if (!t) return 'Untitled';
  // Cut at the first clause break that leaves something meaningful.
  const breaks = [': ', '; ', ' (', ', including', ' including ', ', with ', ' with reference to', ', and ', ' — ', ' – '];
  for (const b of breaks) {
    const at = t.indexOf(b);
    if (at >= 12 && at < t.length - 1) t = t.slice(0, at);
  }
  if (t.length > max) {
    const cut = t.lastIndexOf(' ', max - 1);
    t = `${t.slice(0, cut > 20 ? cut : max - 1).replace(/[,;:]$/, '')}…`;
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}
