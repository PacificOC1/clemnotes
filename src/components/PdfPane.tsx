import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { getImage } from '../db/imageRepository';
import { addHighlight, highlightsFor, pdfInfo, type PdfHighlight } from '../db/pdfRepository';
import { loadImage } from '../sync/imageSync';
import { loadPdfjs, openPdf } from '../pdf/pdfjs';
import { cleanSelectionText, toPageRects, type PageRect } from '../pdf/geometry';
import { onOpenPdfRequest, takePdfTarget } from '../pdf/pdfEvents';
import { logError, logEvent } from '../diagnostics';
import '../pdf/textLayer.css';

/**
 * Reading a PDF beside the outline (#53).
 *
 * Pages are drawn by pdf.js onto a canvas, with its transparent text layer on
 * top so the text can be selected. Only pages near the viewport are drawn, so
 * a 400-page book costs what the few pages on screen cost. Select a passage and
 * the toolbar offers to highlight it — a rem quoting it, starting with a page
 * chip — or to make a card whose answer is the passage. Existing highlights
 * are drawn over the page; clicking one shows its rem.
 */

interface Props {
  fileId: string;
  /** The page the route asks for. */
  page?: number;
  /** Where highlights go when the PDF's own rem can't be found. */
  fallbackParentId: string | null;
  onClose: () => void;
  /** The page being read changed — kept in the URL, without new history. */
  onPageSeen: (page: number) => void;
  onShowRem: (nodeId: string) => void;
  /** A card was made: put the cursor in its question. */
  onEditRem: (nodeId: string, cursor: number) => void;
}

interface Size {
  w: number;
  h: number;
}

interface Pending {
  page: number;
  rects: PageRect[];
  text: string;
  /** Where to put the toolbar, in the scroller's content coordinates. */
  x: number;
  y: number;
}

const PAGE_GAP = 12;
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function PdfPane({ fileId, page, fallbackParentId, onClose, onPageSeen, onShowRem, onEditRem }: Props) {
  const stored = useLiveQuery(async () => (await getImage(fileId)) ?? null, [fileId]);
  const info = useLiveQuery(() => pdfInfo(fileId), [fileId]);
  const highlights = useLiveQuery(() => highlightsFor(fileId), [fileId]);

  const [missing, setMissing] = useState(false);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const [pending, setPending] = useState<Pending | null>(null);
  const [flash, setFlash] = useState<{ page: number; rects: PageRect[] } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Not on this device yet: fetch it from cloud storage, like an image.
  useEffect(() => {
    if (stored !== null) return;
    let cancelled = false;
    void loadImage(fileId).then((found) => {
      if (!cancelled && !found) setMissing(true);
    });
    return () => {
      cancelled = true;
    };
  }, [stored, fileId]);

  // Open the document once its bytes are here.
  const bytes = stored?.data;
  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    let close: (() => void) | null = null;
    setDoc(null);
    setFailed(null);
    void openPdf(bytes)
      .then(async (opened) => {
        close = opened.close;
        const pdf = opened.doc;
        if (cancelled) {
          opened.close();
          return;
        }
        const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
        if (cancelled) return;
        // Every page assumed the first page's size until it is drawn.
        setSizes(Array.from({ length: pdf.numPages }, () => ({ w: first.width, h: first.height })));
        setDoc(pdf);
        logEvent('pdf', 'Opened a PDF', { pages: pdf.numPages });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        logError('pdf', err);
        setFailed(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      (close as (() => void) | null)?.();
    };
  }, [bytes]);

  // Fit to the pane's width; zoom is relative to that.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  const base = sizes[0]?.w ?? 612;
  const scale = width > 0 ? (zoom * Math.max(200, width - 32)) / base : 0;

  const pageTop = useCallback(
    (n: number) => {
      let top = PAGE_GAP;
      for (let i = 0; i < n - 1 && i < sizes.length; i++) top += Math.floor(sizes[i]!.h * scale) + PAGE_GAP;
      return top;
    },
    [sizes, scale]
  );

  const scrollToPage = useCallback(
    (n: number, rects?: PageRect[]) => {
      const el = scroller.current;
      if (!el || !sizes.length || scale <= 0) return;
      const target = Math.min(Math.max(1, n), sizes.length);
      const firstRect = rects?.[0];
      const offset = firstRect ? firstRect.y * sizes[target - 1]!.h * scale - el.clientHeight / 3 : -PAGE_GAP;
      el.scrollTop = Math.max(0, pageTop(target) + offset);
      setCurrent(target);
      if (rects?.length) {
        setFlash({ page: target, rects });
        window.setTimeout(() => setFlash(null), 1600);
      }
    },
    [sizes, scale, pageTop]
  );

  // Where to start: a highlight's page chip that asked for this PDF, else the
  // page in the URL. And again whenever a chip asks while it is already open.
  const ready = doc !== null && scale > 0;
  const lastRoutePage = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!ready) return;
    const target = takePdfTarget(fileId);
    if (target) scrollToPage(target.page, target.rects);
    else if (page && page !== current) scrollToPage(page);
    lastRoutePage.current = page;
    // Only on opening, or on a route that names a different page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fileId]);
  useEffect(() => {
    if (!ready || page === lastRoutePage.current) return;
    lastRoutePage.current = page;
    if (page && page !== current) scrollToPage(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  useEffect(
    () =>
      onOpenPdfRequest((id, target) => {
        if (id !== fileId || !ready || !target) return;
        takePdfTarget(id);
        scrollToPage(target.page, target.rects);
      }),
    [fileId, ready, scrollToPage]
  );

  // Which page is being read, from the scroll position.
  function handleScroll() {
    const el = scroller.current;
    if (!el || !sizes.length) return;
    const probe = el.scrollTop + el.clientHeight / 3;
    let n = 1;
    while (n < sizes.length && pageTop(n + 1) <= probe) n++;
    if (n !== current) {
      setCurrent(n);
      lastRoutePage.current = n;
      onPageSeen(n);
    }
    if (pending) setPending(null);
  }

  // A selection inside a page's text layer offers the toolbar.
  function readSelection() {
    const selection = window.getSelection();
    const el = scroller.current;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !el) {
      setPending(null);
      return;
    }
    const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
    const pageEl = anchor?.closest<HTMLElement>('.pdf-page');
    if (!pageEl || !el.contains(pageEl)) {
      setPending(null);
      return;
    }
    const text = cleanSelectionText(selection.toString());
    const pageBox = pageEl.getBoundingClientRect();
    const rects = toPageRects([...selection.getRangeAt(0).getClientRects()], pageBox);
    if (!text || rects.length === 0) {
      setPending(null);
      return;
    }
    const last = rects[rects.length - 1]!;
    const hostBox = el.getBoundingClientRect();
    setPending({
      page: Number(pageEl.dataset.page),
      rects,
      text,
      x: pageBox.left - hostBox.left + (last.x + last.w) * pageBox.width,
      y: pageBox.top - hostBox.top + el.scrollTop + (last.y + last.h) * pageBox.height + 6,
    });
  }

  async function keep(asCard: boolean) {
    if (!pending) return;
    const made = await addHighlight({ fileId, page: pending.page, rects: pending.rects, text: pending.text, asCard, fallbackParentId });
    window.getSelection()?.removeAllRanges();
    setPending(null);
    if (!made) return;
    logEvent('pdf', asCard ? 'Made a card from a PDF' : 'Highlighted a PDF', { page: pending.page });
    if (asCard) onEditRem(made.nodeId, made.cursor);
  }

  const byPage = useMemo(() => {
    const map = new Map<number, PdfHighlight[]>();
    for (const h of highlights ?? []) map.set(h.page, [...(map.get(h.page) ?? []), h]);
    return map;
  }, [highlights]);

  // Pages are assumed to be the first page's size until drawn; correct them then.
  const measure = useCallback((number: number, measured: Size) => {
    setSizes((all) => {
      const i = number - 1;
      const known = all[i];
      return known && (known.w !== measured.w || known.h !== measured.h) ? all.map((s, j) => (j === i ? measured : s)) : all;
    });
  }, []);

  const name = info?.name ?? 'PDF';
  const zoomIndex = ZOOMS.indexOf(zoom);

  let body;
  if (failed) {
    body = <p className="pdf-status">This PDF couldn’t be opened: {failed}</p>;
  } else if (stored === null && missing) {
    body = (
      <p className="pdf-status">
        This PDF isn’t on this device yet. It appears once the device it was added on has synced, and you’re signed
        in here.
      </p>
    );
  } else if (!doc) {
    body = <p className="pdf-status">Opening…</p>;
  } else {
    body = sizes.map((size, i) => (
      <PdfPage
        key={i}
        doc={doc}
        number={i + 1}
        size={size}
        scale={scale}
        highlights={byPage.get(i + 1) ?? []}
        flash={flash?.page === i + 1 ? flash.rects : null}
        onShowRem={onShowRem}
        onMeasured={measure}
      />
    ));
  }

  return (
    <section className="split-pane pdf-pane" aria-label={`PDF: ${name}`}>
      <header className="split-head">
        <span className="split-title" title={name}>
          {name}
        </span>
        <div className="topbar-spacer" />
        {doc && (
          <span className="pdf-pages" aria-live="polite">
            {current} / {sizes.length}
          </span>
        )}
        <button
          type="button"
          className="icon-btn"
          onClick={() => setZoom(ZOOMS[Math.max(0, zoomIndex - 1)] ?? 1)}
          disabled={zoomIndex <= 0}
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
        <button type="button" className="icon-btn pdf-zoom" onClick={() => setZoom(1)} title="Fit to width" aria-label="Fit to width">
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, zoomIndex + 1)] ?? 1)}
          disabled={zoomIndex >= ZOOMS.length - 1}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button type="button" className="icon-btn" onClick={onClose} title="Close the PDF" aria-label="Close PDF">
          ✕
        </button>
      </header>
      <div
        className="pdf-scroller"
        ref={scroller}
        onScroll={handleScroll}
        onMouseUp={() => window.setTimeout(readSelection, 0)}
        onKeyUp={(e) => {
          if (e.shiftKey) readSelection();
        }}
      >
        <div className="pdf-pages-col">{body}</div>
        {pending && (
          <div
            className="pdf-toolbar"
            style={{ left: Math.max(8, pending.x - 150), top: pending.y }}
            onMouseDown={(e) => e.preventDefault()}
            role="toolbar"
            aria-label="Keep this passage"
          >
            <button type="button" className="pdf-toolbar-btn" onClick={() => void keep(false)}>
              Highlight
            </button>
            <button type="button" className="pdf-toolbar-btn" onClick={() => void keep(true)} title="A flashcard whose answer is this passage">
              Make card
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

interface PageProps {
  doc: PDFDocumentProxy;
  number: number;
  size: Size;
  scale: number;
  highlights: PdfHighlight[];
  flash: PageRect[] | null;
  onShowRem: (nodeId: string) => void;
  onMeasured: (number: number, size: Size) => void;
}

/** One page: a placeholder of the right size until it is near the screen, then canvas and text. */
function PdfPage({ doc, number, size, scale, highlights, flash, onShowRem, onMeasured }: PageProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setNear(Boolean(entry?.isIntersecting)), {
      root: el.closest('.pdf-scroller'),
      rootMargin: '1200px 0px',
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!near || scale <= 0) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let layer: { cancel(): void } | null = null;
    void (async () => {
      try {
        const [pdfjs, page] = await Promise.all([loadPdfjs(), doc.getPage(number)]);
        if (cancelled) return;
        const natural = page.getViewport({ scale: 1 });
        if (natural.width !== size.w || natural.height !== size.h) onMeasured(number, { w: natural.width, h: natural.height });
        const viewport = page.getViewport({ scale });
        const c = canvas.current;
        const t = textLayer.current;
        if (!c || !t) return;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        c.width = Math.floor(viewport.width * ratio);
        c.height = Math.floor(viewport.height * ratio);
        const context = c.getContext('2d');
        if (!context) return;
        task = page.render({
          canvas: c,
          canvasContext: context,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        });
        t.replaceChildren();
        const text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: t, viewport });
        layer = text;
        await Promise.all([task.promise, text.render()]);
      } catch (err) {
        if (!cancelled && !(err instanceof Error && err.name === 'RenderingCancelledException')) logError('pdf', err);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
    };
  }, [near, scale, doc, number, size.w, size.h, onMeasured]);

  // The text layer sits on top (so text stays selectable), so a click on a
  // highlight is found by position — and only when it didn't select anything.
  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!window.getSelection()?.isCollapsed) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    const hit = highlights.find((h) => h.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h));
    if (hit) onShowRem(hit.nodeId);
  }

  const width = Math.floor(size.w * scale);
  const height = Math.floor(size.h * scale);
  const box = (r: PageRect) => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });

  return (
    <div
      ref={host}
      className="pdf-page"
      data-page={number}
      style={
        {
          width,
          height,
          '--total-scale-factor': scale,
          '--scale-round-x': '1px',
          '--scale-round-y': '1px',
        } as React.CSSProperties
      }
      aria-label={`Page ${number}`}
      onClick={handleClick}
    >
      {near && (
        <>
          <canvas ref={canvas} className="pdf-canvas" aria-hidden="true" />
          <div className="pdf-highlights" aria-hidden="true">
            {highlights.flatMap((h) =>
              h.rects.map((r, i) => <div key={`${h.nodeId}-${i}`} className="pdf-hl" style={box(r)} title={h.text} />)
            )}
            {flash?.map((r, i) => <div key={`flash-${i}`} className="pdf-flash" style={box(r)} />)}
          </div>
          <div
            ref={textLayer}
            className="textLayer"
            onMouseDown={(e) => e.currentTarget.classList.add('selecting')}
            onMouseUp={(e) => e.currentTarget.classList.remove('selecting')}
          />
        </>
      )}
    </div>
  );
}
