/**
 * Hand a generated file to the browser.
 *
 * Kept in its own module so the export code below stays pure: everything that
 * builds a backup or renders Markdown returns a string, and only this touches
 * the DOM. That is what lets the exporters be exercised outside a browser.
 */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  // Firefox needs the anchor in the document before a click counts.
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `2026-09-10-1432` — sortable, and safe in a filename on every platform. */
export function timestampSlug(now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** Turn a rem's title into something that can be a filename. */
export function slugify(title: string, fallback = 'untitled'): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}
