import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { storePdf } from '../db/imageRepository';
import { decodeRects } from '../pdf/geometry';
import { requestOpenPdf } from '../pdf/pdfEvents';

/**
 * PDFs in a rem (#53): the block that holds one, and the page chip that starts
 * every passage highlighted in it.
 */

function formatSize(bytes: unknown): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} kB`;
}

/** What a PDF block shows — shared with the static rendering. */
export function PdfBlockBody({ attrs }: { attrs: Record<string, unknown> | undefined }) {
  const fileId = String(attrs?.fileId ?? '');
  const name = String(attrs?.name ?? '') || 'PDF';
  const size = formatSize(attrs?.size);
  return (
    <div className="pdf-block-inner">
      <span className="pdf-block-icon" aria-hidden="true">
        PDF
      </span>
      <span className="pdf-block-name">{name}</span>
      {size && <span className="pdf-block-size">{size}</span>}
      <button type="button" className="pdf-block-open" onClick={() => requestOpenPdf(fileId)}>
        Read beside
      </button>
    </div>
  );
}

function PdfBlockView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper className="pdf-block" contentEditable={false}>
      <PdfBlockBody attrs={node.attrs} />
    </NodeViewWrapper>
  );
}

/** A highlight's page chip — shared with the static rendering. */
export function usePdfAnchorView(attrs: Record<string, unknown> | undefined) {
  const fileId = String(attrs?.fileId ?? '');
  const page = Math.max(1, Number(attrs?.page ?? 1));
  return {
    label: `p. ${page}`,
    title: `Show this passage — page ${page} of the PDF`,
    onClick: (event: React.MouseEvent) => {
      event.preventDefault();
      requestOpenPdf(fileId, { page, rects: decodeRects(attrs?.rects) });
    },
  };
}

function PdfAnchorView({ node }: NodeViewProps) {
  const view = usePdfAnchorView(node.attrs);
  return (
    <NodeViewWrapper as="span" className="pdf-anchor" title={view.title} onClick={view.onClick}>
      {view.label}
    </NodeViewWrapper>
  );
}

function pdfFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
}

/** Store PDFs and put a block for each at `pos` (or the selection), then open the first. */
export async function insertPdfFiles(view: EditorView, files: File[], pos?: number): Promise<number> {
  let inserted = 0;
  let first: string | null = null;
  for (const file of files) {
    try {
      const stored = await storePdf(file);
      const type = view.state.schema.nodes.remPdf;
      if (!type || view.isDestroyed) break;
      const block = type.create({ fileId: stored.id, name: file.name.replace(/\.pdf$/i, ''), size: stored.size });
      const at = pos === undefined ? undefined : Math.min(pos, view.state.doc.content.size);
      const tr = at === undefined ? view.state.tr.replaceSelectionWith(block) : view.state.tr.replaceRangeWith(at, at, block);
      view.dispatch(tr.scrollIntoView());
      first ??= stored.id;
      inserted += 1;
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'That PDF could not be added.');
    }
  }
  if (first) requestOpenPdf(first);
  return inserted;
}

/** `/pdf` — pick a file from disk. */
export function pickPdfInto(editor: Editor): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf,.pdf';
  input.onchange = () => {
    const files = pdfFiles(input.files);
    if (files.length > 0) void insertPdfFiles(editor.view, files);
  };
  input.click();
}

export const RemPdf = Node.create({
  name: 'remPdf',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      fileId: { default: null },
      name: { default: '' },
      size: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-pdf-id]', getAttrs: (el) => ({ fileId: (el as HTMLElement).getAttribute('data-pdf-id') }) }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-pdf-id': node.attrs.fileId })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(PdfBlockView);
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('remPdfPasteDrop'),
        props: {
          handlePaste: (view, event) => {
            const files = pdfFiles(event.clipboardData?.files);
            if (files.length === 0) return false;
            event.preventDefault();
            void insertPdfFiles(view, files);
            return true;
          },
          handleDrop: (view, event) => {
            const files = pdfFiles((event as DragEvent).dataTransfer?.files);
            if (files.length === 0) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            void insertPdfFiles(view, files, at?.pos);
            return true;
          },
        },
      }),
    ];
  },
});

export const PdfAnchor = Node.create({
  name: 'pdfAnchor',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      fileId: { default: null },
      page: { default: 1 },
      /** Where on the page, as fractions — see `pdf/geometry.ts`. */
      rects: { default: '[]' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-pdf-anchor]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-pdf-anchor': '' }), `p. ${node.attrs.page}`];
  },

  renderText({ node }) {
    return `(p. ${node.attrs.page})`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(PdfAnchorView);
  },
});
