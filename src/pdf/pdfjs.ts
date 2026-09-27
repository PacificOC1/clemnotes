import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * pdf.js, fetched the first time a PDF is opened (#53).
 *
 * The library and its worker are well over a megabyte — more than the rest of
 * the app — and most sessions never open a PDF, so neither is part of the
 * startup bundle (the budget check would say so) or of the offline precache;
 * the service worker caches them the first time they're used.
 */
type Pdfjs = typeof import('pdfjs-dist');

let loading: Promise<Pdfjs> | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  // The "legacy" build: the same library with polyfills for JavaScript newer
  // than most browsers ship (pdf.js 6 uses `Map#getOrInsertComputed`).
  loading ??= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<Pdfjs>,
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]).then(
    ([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    }
  );
  return loading;
}

export interface OpenedPdf {
  doc: PDFDocumentProxy;
  /** Free the document and its worker-side state. */
  close: () => void;
}

/** Open a PDF from its bytes. The bytes are copied: pdf.js takes ownership of what it is given. */
export async function openPdf(bytes: ArrayBuffer): Promise<OpenedPdf> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  const doc = await task.promise;
  return { doc, close: () => void task.destroy() };
}
