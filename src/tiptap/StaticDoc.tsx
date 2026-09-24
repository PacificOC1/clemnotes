import { Fragment, useMemo, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import type { DocNode } from './docUtils';
import { useWikiLinkView } from './WikiLinkNode';
import { useTagView } from './TagNode';
import { useMathHtml } from './MathNode';
import { ImageTools, imageSizeOf, useRemImage } from './ImageNode';
import { compileMatcher } from './dictionaryMatcher';
import { DICTIONARY_UPDATED_EVENT, getDictionaryEntries } from '../db/dictionaryStore';

/**
 * A rem drawn from its stored document, without an editor (#19).
 *
 * Every rem used to mount its own Tiptap editor, each a full ProseMirror view
 * with a dozen plugins — so a 500-rem page built 500 editors before you could
 * read it. Almost all of them are only ever looked at. This renders the same
 * document as plain React elements, with the same tags and classes the editor
 * produces, so a rem looks identical whether it is being edited or not, and
 * the row mounts a real editor only once you click into it.
 *
 * Links, tags, maths, clozes, images and dictionary underlines are drawn by
 * the same hooks their editor node views use. Anything this renderer doesn't
 * know — a query block, or a node type added later and not taught here — makes
 * `docNeedsEditor` say so, and the row keeps a real editor for it.
 */

/** Node types this renderer can draw. */
const STATIC_NODES = new Set([
  'doc',
  'paragraph',
  'heading',
  'text',
  'hardBreak',
  'horizontalRule',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'wikiLink',
  'tag',
  'math',
  'cloze',
  'remImage',
]);

/** True when a document holds something only a live editor can draw. */
export function docNeedsEditor(doc: DocNode): boolean {
  if (!STATIC_NODES.has(doc.type)) return true;
  return (doc.content ?? []).some(docNeedsEditor);
}

function subscribeDictionary(onChange: () => void): () => void {
  window.addEventListener(DICTIONARY_UPDATED_EVENT, onChange);
  return () => window.removeEventListener(DICTIONARY_UPDATED_EVENT, onChange);
}

/** The dictionary, re-read whenever it changes. */
function useDictionary() {
  return useSyncExternalStore(subscribeDictionary, getDictionaryEntries, getDictionaryEntries);
}

type Matcher = ReturnType<typeof compileMatcher>;

interface RenderContext {
  matcher: Matcher | null;
  /** Editing affordances (image size buttons) — on for outline rows, off for card faces. */
  editable: boolean;
}

function alignStyle(attrs: DocNode['attrs']): CSSProperties | undefined {
  const align = attrs?.textAlign;
  return typeof align === 'string' && align && align !== 'left' ? { textAlign: align as CSSProperties['textAlign'] } : undefined;
}

/** ProseMirror puts a `<br>` in an empty textblock so it keeps its height. */
function orTrailingBreak(children: ReactNode[]): ReactNode[] {
  return children.length > 0 ? children : [<br key="br" className="ProseMirror-trailingBreak" />];
}

function textStyle(attrs: Record<string, unknown> | undefined): CSSProperties {
  const style: CSSProperties = {};
  if (typeof attrs?.color === 'string' && attrs.color) style.color = attrs.color;
  if (typeof attrs?.fontFamily === 'string' && attrs.fontFamily) style.fontFamily = attrs.fontFamily;
  if (typeof attrs?.fontSize === 'string' && attrs.fontSize) style.fontSize = attrs.fontSize;
  return style;
}

function wrapMark(mark: { type: string; attrs?: Record<string, unknown> }, child: ReactNode, key: string): ReactNode {
  switch (mark.type) {
    case 'bold':
      return <strong key={key}>{child}</strong>;
    case 'italic':
      return <em key={key}>{child}</em>;
    case 'strike':
      return <s key={key}>{child}</s>;
    case 'underline':
      return <u key={key}>{child}</u>;
    case 'code':
      return <code key={key}>{child}</code>;
    case 'link': {
      const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : undefined;
      return (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
          {child}
        </a>
      );
    }
    case 'highlight': {
      const color = typeof mark.attrs?.color === 'string' ? mark.attrs.color : null;
      return (
        <mark key={key} data-color={color ?? undefined} style={color ? { backgroundColor: color, color: 'inherit' } : undefined}>
          {child}
        </mark>
      );
    }
    case 'textStyle':
      return (
        <span key={key} style={textStyle(mark.attrs)}>
          {child}
        </span>
      );
    default:
      return <span key={key}>{child}</span>;
  }
}

/** A text node: dictionary underlines innermost, then its marks, as ProseMirror nests them. */
function renderText(node: DocNode, key: string, ctx: RenderContext): ReactNode {
  const text = node.text ?? '';
  const marks = node.marks ?? [];
  let inner: ReactNode = text;

  if (ctx.matcher && !marks.some((m) => m.type === 'code')) {
    const matches = ctx.matcher.find(text);
    if (matches.length > 0) {
      const parts: ReactNode[] = [];
      let at = 0;
      matches.forEach((match, i) => {
        if (match.from > at) parts.push(text.slice(at, match.from));
        parts.push(
          <span
            key={i}
            className="dict-word"
            data-entry-id={match.entry.id}
            data-definition={match.entry.definition}
            data-word={match.entry.displayWord}
            title="Click to replace with definition · Shift+click to edit in Dictionary"
          >
            {text.slice(match.from, match.to)}
          </span>
        );
        at = match.to;
      });
      if (at < text.length) parts.push(text.slice(at));
      inner = parts;
    }
  }

  for (let i = marks.length - 1; i >= 0; i--) inner = wrapMark(marks[i]!, inner, `${key}m${i}`);
  return marks.length > 0 ? inner : <Fragment key={key}>{inner}</Fragment>;
}

function StaticWikiLink({ attrs }: { attrs: DocNode['attrs'] }) {
  const view = useWikiLinkView(attrs);
  return (
    <span className={view.className} title={view.title} onClick={view.onClick} style={{ whiteSpace: 'normal' }}>
      {view.label}
    </span>
  );
}

function StaticTag({ attrs }: { attrs: DocNode['attrs'] }) {
  const view = useTagView(attrs);
  return (
    <span className={view.className} onClick={view.onClick} style={{ whiteSpace: 'normal' }}>
      {view.label}
    </span>
  );
}

function StaticMath({ latex }: { latex: string }) {
  const html = useMathHtml(latex);
  return (
    <span
      className="math-node"
      title="Click to edit"
      style={{ whiteSpace: 'normal' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function StaticImage({ attrs, tools }: { attrs: DocNode['attrs']; tools: boolean }) {
  const { url, body } = useRemImage(String(attrs?.imageId ?? ''), String(attrs?.alt ?? ''));
  const size = imageSizeOf(attrs);
  return (
    <div className={`rem-image rem-image-${size}`}>
      {body}
      {/* Drawn so they appear on hover as in the editor; a click on one opens the editor and is replayed there. */}
      {url && tools && <ImageTools url={url} size={size} />}
    </div>
  );
}

const VISUALLY_HIDDEN: CSSProperties = {
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  height: 1,
  overflow: 'hidden',
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: 1,
};

function textOf(node: DocNode): string {
  return node.text ?? (node.content ?? []).map(textOf).join('');
}

function renderChildren(node: DocNode, key: string, ctx: RenderContext): ReactNode[] {
  return (node.content ?? []).map((child, i) => renderNode(child, `${key}.${i}`, ctx));
}

function renderNode(node: DocNode, key: string, ctx: RenderContext): ReactNode {
  const attrs = node.attrs;
  switch (node.type) {
    case 'text':
      return renderText(node, key, ctx);
    case 'paragraph':
      return (
        <p key={key} style={alignStyle(attrs)}>
          {orTrailingBreak(renderChildren(node, key, ctx))}
        </p>
      );
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(attrs?.level ?? 1)));
      const Tag = `h${level}` as 'h1';
      return (
        <Tag key={key} style={alignStyle(attrs)}>
          {orTrailingBreak(renderChildren(node, key, ctx))}
        </Tag>
      );
    }
    case 'hardBreak':
      return <br key={key} />;
    case 'horizontalRule':
      return <hr key={key} />;
    case 'blockquote':
      return <blockquote key={key}>{renderChildren(node, key, ctx)}</blockquote>;
    case 'codeBlock': {
      const language = typeof attrs?.language === 'string' && attrs.language ? `language-${attrs.language}` : undefined;
      // No dictionary underlines in code, as in the editor.
      const text = (node.content ?? []).map((child) => child.text ?? '').join('');
      return (
        <pre key={key}>
          <code className={language}>{text || <br className="ProseMirror-trailingBreak" />}</code>
        </pre>
      );
    }
    case 'bulletList':
      return <ul key={key}>{renderChildren(node, key, ctx)}</ul>;
    case 'orderedList': {
      const start = Number(attrs?.start ?? 1);
      return (
        <ol key={key} start={start !== 1 ? start : undefined}>
          {renderChildren(node, key, ctx)}
        </ol>
      );
    }
    case 'listItem':
      return <li key={key}>{renderChildren(node, key, ctx)}</li>;
    case 'taskList':
      return (
        <ul key={key} data-type="taskList">
          {renderChildren(node, key, ctx)}
        </ul>
      );
    case 'taskItem': {
      const checked = Boolean(attrs?.checked);
      // The same accessible name the editor's task item gives its checkbox.
      const label = `Task item checkbox for ${textOf(node) || 'empty task item'}`;
      return (
        <li key={key} data-checked={String(checked)} data-type="taskItem">
          <label>
            {/* Toggled through the editor: clicking it mounts one and replays the click. */}
            <input type="checkbox" checked={checked} readOnly aria-label={label} />
            <span style={VISUALLY_HIDDEN}>{label}</span>
          </label>
          <div>{renderChildren(node, key, ctx)}</div>
        </li>
      );
    }
    case 'table': {
      const firstRow = node.content?.[0];
      const widths = (firstRow?.content ?? []).flatMap((cell) => {
        const span = Number(cell.attrs?.colspan ?? 1);
        const colwidth = Array.isArray(cell.attrs?.colwidth) ? (cell.attrs.colwidth as unknown[]) : [];
        return Array.from({ length: span }, (_, i) => (typeof colwidth[i] === 'number' ? (colwidth[i] as number) : null));
      });
      return (
        <div key={key} className="tableWrapper">
          <table>
            <colgroup>
              {widths.map((width, i) => (
                <col key={i} style={width ? { width: `${width}px` } : { minWidth: '25px' }} />
              ))}
            </colgroup>
            <tbody>{renderChildren(node, key, ctx)}</tbody>
          </table>
        </div>
      );
    }
    case 'tableRow':
      return <tr key={key}>{renderChildren(node, key, ctx)}</tr>;
    case 'tableCell':
    case 'tableHeader': {
      const Cell = node.type === 'tableHeader' ? 'th' : 'td';
      const colspan = Number(attrs?.colspan ?? 1);
      const rowspan = Number(attrs?.rowspan ?? 1);
      return (
        <Cell key={key} colSpan={colspan !== 1 ? colspan : undefined} rowSpan={rowspan !== 1 ? rowspan : undefined}>
          {renderChildren(node, key, ctx)}
        </Cell>
      );
    }
    case 'wikiLink':
      return <StaticWikiLink key={key} attrs={attrs} />;
    case 'tag':
      return <StaticTag key={key} attrs={attrs} />;
    case 'math':
      return <StaticMath key={key} latex={String(attrs?.latex ?? '')} />;
    case 'cloze': {
      const index = Number(attrs?.index ?? 1);
      const state = attrs?.state as string | null | undefined;
      if (state === 'hidden') {
        return (
          <span key={key} className="cloze cloze-hidden" data-index={index} style={{ whiteSpace: 'normal' }}>
            [&nbsp;…&nbsp;]
          </span>
        );
      }
      return (
        <span
          key={key}
          className={`cloze ${state === 'revealed' ? 'cloze-revealed' : ''}`}
          data-index={index}
          title={`Cloze ${index}`}
          style={{ whiteSpace: 'normal' }}
        >
          {String(attrs?.text ?? '')}
        </span>
      );
    }
    case 'remImage':
      return <StaticImage key={key} attrs={attrs} tools={ctx.editable} />;
    default:
      // `docNeedsEditor` keeps unknown types away from here; draw their text rather than nothing.
      return <span key={key}>{renderChildren(node, key, ctx)}</span>;
  }
}

function isEmptyDoc(doc: DocNode): boolean {
  const blocks = doc.content ?? [];
  return blocks.length === 0 || (blocks.length === 1 && blocks[0]!.type === 'paragraph' && !blocks[0]!.content?.length);
}

interface StaticDocProps {
  doc: DocNode;
  /** Classes for the element that stands in for the editor's own. */
  className?: string;
  /** Underline dictionary words, as the editable rows do. */
  dictionary?: boolean;
  /** Shown in an empty rem, as the editor's placeholder is. */
  placeholder?: string;
  /**
   * Mirror the editor's trailing-paragraph rule (a doc that ends in anything
   * but a paragraph gets an empty one after it), so the row keeps its height
   * when the editor takes over.
   */
  trailingParagraph?: boolean;
  /** Show the controls the editor shows on hover (an outline row, not a card face). */
  editable?: boolean;
}

export function StaticDoc({ doc, className = '', dictionary = false, placeholder, trailingParagraph = false, editable = false }: StaticDocProps) {
  const entries = useDictionary();
  const matcher = useMemo(() => (dictionary && entries.size > 0 ? compileMatcher(entries) : null), [dictionary, entries]);

  const blocks = useMemo(() => {
    const ctx: RenderContext = { matcher, editable };
    if (isEmptyDoc(doc)) {
      return [
        <p key="empty" className="is-empty is-editor-empty" data-placeholder={placeholder}>
          <br className="ProseMirror-trailingBreak" />
        </p>,
      ];
    }
    const out = renderChildren(doc, 'n', ctx);
    const last = doc.content?.[doc.content.length - 1];
    if (trailingParagraph && last && last.type !== 'paragraph') {
      out.push(
        <p key="trailing">
          <br className="ProseMirror-trailingBreak" />
        </p>
      );
    }
    return out;
  }, [doc, matcher, placeholder, trailingParagraph, editable]);

  return (
    <div className={`tiptap ProseMirror rem-static ${className}`} translate="no">
      {blocks}
    </div>
  );
}
