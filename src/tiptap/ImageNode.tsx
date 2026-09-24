import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getImage, storeImage } from '../db/imageRepository';
import type { StoredImage } from '../db/schema';
import { loadImage } from '../sync/imageSync';

/**
 * An image in a rem.
 *
 * The node stores an `imageId`, never a URL: the bytes are in IndexedDB (see
 * `imageRepository.ts`), so the picture renders offline and the doc — which
 * is synced and rewritten on every keystroke — stays a few hundred bytes. A
 * device that doesn't have the bytes yet fetches them from cloud storage the
 * first time it draws the image.
 */

export type ImageSize = 'small' | 'medium' | 'full';

/**
 * Object URLs, shared and kept.
 *
 * Making one per render and revoking it on unmount breaks under StrictMode,
 * which unmounts once straight after mounting and leaves the <img> pointing
 * at a revoked URL — and every rem showing the same image would make its
 * own. So they are cached by image (and version), and the oldest are revoked
 * once there are more than any page could reasonably show at once.
 */
const urls = new Map<string, string>();
const URL_CACHE_LIMIT = 200;

function objectUrlFor(image: StoredImage): string {
  const key = `${image.id}:${image.updatedAt}`;
  const cached = urls.get(key);
  if (cached) {
    // Re-insert, so the map's order is least-recently-used first.
    urls.delete(key);
    urls.set(key, cached);
    return cached;
  }
  const url = URL.createObjectURL(new Blob([image.data], { type: image.mime }));
  urls.set(key, url);
  while (urls.size > URL_CACHE_LIMIT) {
    const [oldestKey, oldestUrl] = urls.entries().next().value as [string, string];
    URL.revokeObjectURL(oldestUrl);
    urls.delete(oldestKey);
  }
  return url;
}
const SIZES: ImageSize[] = ['small', 'medium', 'full'];

/** The last row read for each image, to draw from before the live query answers. */
const lastSeen = new Map<string, StoredImage | null>();

/** The S / M / L and open-full-size controls, shown on hover. */
export function ImageTools({ url, size, onSize }: { url: string; size: ImageSize; onSize?: (size: ImageSize) => void }) {
  return (
    <div className="rem-image-tools">
      {SIZES.map((option) => (
        <button
          key={option}
          type="button"
          className={option === size ? 'active' : ''}
          onClick={() => onSize?.(option)}
          title={`Show ${option === 'full' ? 'full width' : option}`}
          aria-label={`Show ${option === 'full' ? 'full width' : option}`}
        >
          {option === 'small' ? 'S' : option === 'medium' ? 'M' : 'L'}
        </button>
      ))}
      <a href={url} target="_blank" rel="noreferrer" title="Open full size" aria-label="Open full size">
        ↗
      </a>
    </div>
  );
}

export function imageSizeOf(attrs: Record<string, unknown> | undefined): ImageSize {
  const size = attrs?.size;
  return (SIZES as unknown[]).includes(size) ? (size as ImageSize) : 'full';
}

/**
 * The picture itself — or a placeholder saying why it isn't here — shared by
 * the editor's node view and the static rendering (#19).
 */
export function useRemImage(imageId: string, alt: string): { url: string | null; body: React.ReactNode } {
  // Live, so an image that arrives from another device appears without a reload.
  // Starts from the last copy seen, so a rem switching between its static and
  // editing forms (#19) never flashes "Loading image…" for a frame.
  const local = useLiveQuery(
    async () => {
      const found = imageId ? ((await getImage(imageId)) ?? null) : null;
      lastSeen.set(imageId, found);
      return found;
    },
    [imageId],
    lastSeen.get(imageId)
  );
  /** The id we asked cloud storage for and came back empty-handed. */
  const [missingFor, setMissingFor] = useState<string | null>(null);

  useEffect(() => {
    if (local !== null || !imageId) return;
    let cancelled = false;
    void loadImage(imageId).then((found) => {
      // A found image lands in IndexedDB, and the live query above picks it up.
      if (!cancelled && !found) setMissingFor(imageId);
    });
    return () => {
      cancelled = true;
    };
  }, [local, imageId]);

  const url = local ? objectUrlFor(local) : null;
  const fetching = local === null && missingFor !== imageId;

  let body;
  if (url) {
    body = <img src={url} alt={alt} draggable={false} />;
  } else if (local === undefined || fetching) {
    body = <div className="rem-image-placeholder">Loading image…</div>;
  } else {
    body = (
      <div className="rem-image-placeholder">
        This image isn’t on this device yet. It appears once the device it was added on has
        synced, and you’re signed in here.
      </div>
    );
  }
  return { url, body };
}

function ImageView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const imageId = String(node.attrs.imageId ?? '');
  const size = imageSizeOf(node.attrs);
  const alt = String(node.attrs.alt ?? '');
  const { url, body } = useRemImage(imageId, alt);

  return (
    <NodeViewWrapper
      className={`rem-image rem-image-${size} ${selected ? 'is-selected' : ''}`}
      contentEditable={false}
    >
      {body}
      {url && editor.isEditable && (
        <ImageTools url={url} size={size} onSize={(option) => updateAttributes({ size: option })} />
      )}
    </NodeViewWrapper>
  );
}

/** Store image files and insert them at `pos` (or the selection). Returns how many went in. */
export async function insertImageFiles(view: EditorView, files: File[], pos?: number): Promise<number> {
  const images = files.filter((file) => file.type.startsWith('image/'));
  let inserted = 0;
  for (const file of images) {
    try {
      const stored = await storeImage(file);
      const type = view.state.schema.nodes.remImage;
      if (!type || view.isDestroyed) break;
      const nodeToInsert = type.create({ imageId: stored.id });
      const tr =
        pos === undefined
          ? view.state.tr.replaceSelectionWith(nodeToInsert)
          : view.state.tr.replaceRangeWith(
              Math.min(pos, view.state.doc.content.size),
              Math.min(pos, view.state.doc.content.size),
              nodeToInsert
            );
      view.dispatch(tr.scrollIntoView());
      inserted += 1;
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'That image could not be added.');
    }
  }
  return inserted;
}

/** `/image` — pick a file from disk. */
export function pickImageInto(editor: Editor): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = () => {
    const files = [...(input.files ?? [])];
    if (files.length > 0) void insertImageFiles(editor.view, files);
  };
  input.click();
}

function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((file) => file.type.startsWith('image/'));
}

export const RemImage = Node.create({
  name: 'remImage',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      imageId: { default: null },
      alt: { default: '' },
      size: { default: 'full' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-image-id]',
        getAttrs: (element) => ({ imageId: (element as HTMLElement).getAttribute('data-image-id') }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['figure', mergeAttributes(HTMLAttributes, { 'data-image-id': node.attrs.imageId })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('remImagePasteDrop'),
        props: {
          // Pasting a screenshot: the clipboard carries the image as a file.
          // Anything else (text, HTML, a copied rem) falls through untouched.
          handlePaste: (view, event) => {
            const files = imageFiles(event.clipboardData?.files);
            if (files.length === 0) return false;
            event.preventDefault();
            void insertImageFiles(view, files);
            return true;
          },
          handleDrop: (view, event) => {
            const files = imageFiles((event as DragEvent).dataTransfer?.files);
            if (files.length === 0) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            void insertImageFiles(view, files, at?.pos);
            return true;
          },
        },
      }),
    ];
  },
});
