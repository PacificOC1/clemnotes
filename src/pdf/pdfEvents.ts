import type { PageRect } from './geometry';

/**
 * "Open this PDF", from anywhere (#53) — a PDF block, a highlight's page chip,
 * a file just dropped into a rem. Editor plugins and node views live outside
 * React's tree of callbacks, so they ask through here and the app, which owns
 * the route, answers.
 */
export interface PdfTarget {
  page: number;
  /** A highlight to scroll to and flash. */
  rects?: PageRect[];
}

type Listener = (fileId: string, target?: PdfTarget) => void;

const listeners = new Set<Listener>();
const pending = new Map<string, PdfTarget>();

export function requestOpenPdf(fileId: string, target?: PdfTarget): void {
  if (target) pending.set(fileId, target);
  for (const listener of listeners) listener(fileId, target);
}

export function onOpenPdfRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The place a reader should show when it opens (or is re-aimed at) this PDF — once. */
export function takePdfTarget(fileId: string): PdfTarget | undefined {
  const target = pending.get(fileId);
  pending.delete(fileId);
  return target;
}
