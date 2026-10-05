/**
 * What kind of file some bytes are, from their first few bytes.
 *
 * Files are stored under their bare id, with no extension — the id is how
 * every device finds them, and a device fetching a file doesn't know what its
 * extension would have been. Supabase keeps the content type it was given;
 * OneDrive hands back `application/octet-stream`, and a PDF has to *be*
 * `application/pdf` for the reader to open it (an SVG likewise for <img>).
 */
export function sniffMime(bytes: Uint8Array, fallback = 'application/octet-stream'): string {
  const at = (i: number) => bytes[i] ?? -1;
  const ascii = (from: number, text: string) => [...text].every((ch, i) => at(from + i) === ch.charCodeAt(0));

  if (ascii(0, '%PDF-')) return 'application/pdf';
  if (at(0) === 0x89 && ascii(1, 'PNG')) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'BM')) return 'image/bmp';
  if (ascii(4, 'ftypavif')) return 'image/avif';

  // SVG is text: look for the root element near the start, past any XML
  // declaration, comments or a byte-order mark.
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 1024)).trimStart();
  if (/^(?:﻿)?(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return 'image/svg+xml';
  }
  return fallback;
}

/** A blob whose type is right, sniffing when the one it came with says nothing useful. */
export async function withSniffedType(blob: Blob): Promise<Blob> {
  if (blob.type && blob.type !== 'application/octet-stream' && blob.type !== 'binary/octet-stream') return blob;
  const data = await blob.arrayBuffer();
  return new Blob([data], { type: sniffMime(new Uint8Array(data)) });
}
