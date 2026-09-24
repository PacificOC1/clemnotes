import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { useActiveEditor } from '../context/ActiveEditorContext';
import { handleMenuKey } from '../editor/menuStore';
import { setFocusIntent, takeFocusIntent } from '../editor/focusIntent';
import {
  createSiblingAfter,
  updateContent,
  ensureFirstChild,
  indentNode,
  outdentNode,
  mergeWithPreviousSibling,
  moveAmongSiblings,
} from '../db/repository';
import { navigateToDictionaryEntry } from '../db/dictionaryStore';
import { rowExtensions } from '../tiptap/extensions';
import { parseDoc, docToPlainText, isDocEmpty, type DocNode } from '../tiptap/docUtils';
import { StaticDoc, docNeedsEditor } from '../tiptap/StaticDoc';
import { hideTooltip, showTooltip } from '../tiptap/DictionaryHighlight';
import { draggingRemId } from './dragState';

/**
 * A rem's text: drawn statically until you click into it, then a real editor (#19).
 *
 * Mounting a ProseMirror editor per rem was what made long documents slow to
 * open — every bullet built its own view and plugin stack whether or not
 * anyone was going to type in it. Now a row shows `StaticDoc`, which renders
 * the stored document to identical markup, and swaps in `LiveRemEditor` when:
 *
 * - you click it — the click is turned into a cursor (or a selection, if you
 *   dragged or double-clicked) at the same spot in the editor that replaces it;
 * - it is asked to take focus (a new bullet, arrowing into it, a search hit);
 * - its document has something only an editor can draw (a query block).
 *
 * It goes back to static when focus moves to another rem. Clicks on things
 * that do something in their own right — a link, a tag, a URL — do that
 * instead of opening the editor; clicks on things whose behaviour lives in
 * the editor (a formula, a dictionary word, a task checkbox) open it and then
 * replay the click there, so they behave exactly as before.
 */

/** Where the click that opened the editor happened, to turn into a selection. */
interface Activation {
  anchor: { x: number; y: number };
  head: { x: number; y: number };
  /** Set when the click landed on something the editor should handle itself. */
  replay: { x: number; y: number; shiftKey: boolean } | null;
}

/** Elements that act on click by themselves, in either mode. */
const OWN_CLICK = '.wiki-link, .tag-chip, a[href]';
/** Elements whose click behaviour belongs to the editor. */
const REPLAY_CLICK = '.math-node, .dict-word, li[data-type="taskItem"] > label, .rem-image-tools button';

interface RemTextProps {
  nodeId: string;
  content: string;
  isRoot?: boolean;
  focusedNodeId: string | null;
  onFocusRequest: (nodeId: string) => void;
}

export function RemText({ nodeId, content, isRoot, focusedNodeId, onFocusRequest }: RemTextProps) {
  const doc = useMemo(() => parseDoc(content), [content]);
  const needsEditor = useMemo(() => docNeedsEditor(doc), [doc]);
  /**
   * A replayed click opens the editor without moving focus here, so it stays
   * open only until focus lands anywhere else: this holds which rem had focus
   * when it opened (`undefined` = not opened that way).
   */
  const [openedWhile, setOpenedWhile] = useState<string | null | undefined>(undefined);
  const activation = useRef<Activation | null>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const staticRef = useRef<HTMLDivElement>(null);

  const live = focusedNodeId === nodeId || openedWhile === focusedNodeId || needsEditor;

  if (live) {
    return (
      <LiveRemEditor
        nodeId={nodeId}
        doc={doc}
        isRoot={isRoot}
        focusedNodeId={focusedNodeId}
        onFocusRequest={onFocusRequest}
        activation={activation}
        onClosed={() => setOpenedWhile(undefined)}
      />
    );
  }

  function handleMouseDown(event: MouseEvent) {
    if (event.button === 0) downAt.current = { x: event.clientX, y: event.clientY };
  }

  function handleMouseUp(event: MouseEvent) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest(OWN_CLICK)) return;

    const dictWord = target.closest('.dict-word');
    if (dictWord && event.shiftKey) {
      // Shift-click on a defined word opens its entry; no editing involved.
      const id = dictWord.getAttribute('data-entry-id');
      if (id) navigateToDictionaryEntry(id);
      return;
    }

    const up = { x: event.clientX, y: event.clientY };
    const down = downAt.current ?? up;
    downAt.current = null;

    let anchor = down;
    let head = up;
    const selection = window.getSelection();
    const root = staticRef.current;
    if (selection && !selection.isCollapsed && root?.contains(selection.anchorNode) && selection.rangeCount > 0) {
      // A double-click or a drag made a real selection in the static text;
      // carry its ends across rather than the pointer positions.
      const rects = selection.getRangeAt(0).getClientRects();
      const first = rects[0];
      const last = rects[rects.length - 1];
      if (first && last) {
        anchor = { x: first.left + 1, y: first.top + first.height / 2 };
        head = { x: last.right - 1, y: last.top + last.height / 2 };
      }
    } else if (Math.abs(down.x - up.x) + Math.abs(down.y - up.y) < 4) {
      anchor = up;
    }

    const replay = target.closest(REPLAY_CLICK) ? { ...up, shiftKey: event.shiftKey } : null;
    activation.current = { anchor, head, replay };
    // Synchronously, so the editor is in place and focused before the next
    // keystroke arrives — typing straight after a click must not lose letters.
    flushSync(() => {
      if (replay) setOpenedWhile(focusedNodeId);
      else onFocusRequest(nodeId);
    });
  }

  // Dictionary definitions on hover, as the editor shows them.
  function handleMouseOver(event: MouseEvent) {
    const word = (event.target as HTMLElement).closest<HTMLElement>('.dict-word');
    if (word) showTooltip(word);
    else hideTooltip();
  }

  return (
    <div
      ref={staticRef}
      className="rem-static-host"
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseOver={handleMouseOver}
      onMouseLeave={hideTooltip}
      data-rem-text={nodeId}
    >
      <StaticDoc
        doc={doc}
        className="rem-editor"
        dictionary
        placeholder={isRoot ? undefined : "Type '/' for commands"}
        trailingParagraph
        editable
      />
    </div>
  );
}

interface LiveRemEditorProps {
  nodeId: string;
  doc: DocNode;
  isRoot?: boolean;
  focusedNodeId: string | null;
  onFocusRequest: (nodeId: string) => void;
  activation: React.MutableRefObject<Activation | null>;
  onClosed: () => void;
}

/** The rows of the document this editor sits in, in reading order. */
function neighbourRow(dom: HTMLElement, nodeId: string, direction: -1 | 1): string | null {
  const scope = dom.closest('.document') ?? document;
  const rows = [...scope.querySelectorAll<HTMLElement>('[data-rem-id]')];
  const index = rows.findIndex((row) => row.dataset.remId === nodeId && row.contains(dom));
  if (index === -1) return null;
  return rows[index + direction]?.dataset.remId ?? null;
}

function LiveRemEditor({ nodeId, doc, isRoot, focusedNodeId, onFocusRequest, activation, onClosed }: LiveRemEditorProps) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWrite = useRef<(() => void) | null>(null);
  const { setActive } = useActiveEditor();

  const editor = useEditor(
    {
      extensions: rowExtensions,
      content: doc,
      onFocus: ({ editor }) => {
        onFocusRequest(nodeId);
        setActive(editor, nodeId);
      },
      onUpdate: ({ editor }) => {
        const json = editor.getJSON() as DocNode;
        const docJson = JSON.stringify(json);
        const plainText = docToPlainText(json);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        const write = () => {
          debounceRef.current = null;
          pendingWrite.current = null;
          void updateContent(nodeId, docJson, plainText);
        };
        pendingWrite.current = write;
        debounceRef.current = setTimeout(write, 300);
      },
      editorProps: {
        attributes: { class: 'rem-editor', 'aria-label': isRoot ? 'Page title' : 'Rem text' },
        // Belt and braces alongside the custom drag type: while a rem drag is in
        // flight, the editor never handles the drop itself.
        handleDrop: (_view, event) => {
          if (!draggingRemId()) return false;
          event.preventDefault();
          return true;
        },
        handleKeyDown: (view, event) => {
          // The slash / [[ menus get first refusal on navigation keys.
          if (handleMenuKey(event)) {
            event.preventDefault();
            return true;
          }

          const { $from } = view.state.selection;
          let insideTable = false;
          for (let d = $from.depth; d > 0; d--) {
            const typeName = $from.node(d).type.name;
            if (typeName === 'tableCell' || typeName === 'tableHeader') {
              insideTable = true;
              break;
            }
          }

          // Alt+↑/↓ moves the whole rem among its siblings.
          if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            void moveAmongSiblings(nodeId, event.key === 'ArrowUp' ? -1 : 1);
            return true;
          }

          // Plain ↑ on the first line / ↓ on the last moves to the rem above or
          // below, as in any outliner — the keyboard way through a document.
          if (
            (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
            !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey &&
            view.state.selection.empty && !insideTable
          ) {
            const up = event.key === 'ArrowUp';
            const topLevel = $from.index(0);
            const atEdge = up ? topLevel === 0 : topLevel === view.state.doc.childCount - 1;
            if (atEdge && view.endOfTextblock(up ? 'up' : 'down')) {
              const next = neighbourRow(view.dom as HTMLElement, nodeId, up ? -1 : 1);
              if (next) {
                event.preventDefault();
                setFocusIntent(next, up ? 'end' : 'start');
                onFocusRequest(next);
                return true;
              }
            }
          }

          if (event.key === 'Enter' && !event.shiftKey && !insideTable) {
            event.preventDefault();
            // The title row's "sibling" is another top-level page, so the usual
            // Enter behaviour turned every stray Return in a heading into a new
            // document. From the title, Enter drops into the body instead —
            // reusing the first bullet if there is one, creating it if not.
            if (isRoot) {
              void ensureFirstChild(nodeId).then((child) => {
                if (child) onFocusRequest(child.id);
              });
              return true;
            }
            createSiblingAfter(nodeId).then((n) => onFocusRequest(n.id));
            return true;
          }
          if (event.key === 'Tab' && !insideTable) {
            event.preventDefault();
            const action = event.shiftKey ? outdentNode(nodeId) : indentNode(nodeId);
            action.then(() => onFocusRequest(nodeId));
            return true;
          }
          if (event.key === 'Backspace') {
            const { selection } = view.state;
            const atStart = selection.empty && selection.from <= 1;
            const empty = isDocEmpty(view.state.doc.toJSON() as DocNode);
            if (atStart && empty) {
              event.preventDefault();
              mergeWithPreviousSibling(nodeId).then((targetId) => {
                if (targetId) onFocusRequest(targetId);
              });
              return true;
            }
          }
          return false;
        },
      },
    },
    []
  );

  // Whatever was typed last is saved when the editor goes away, rather than
  // 300ms later from a row that has already turned back into static text.
  const closed = useRef(onClosed);
  useEffect(() => {
    closed.current = onClosed;
  });
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      pendingWrite.current?.();
      closed.current();
    },
    []
  );

  // Settle the document the way the old always-on editors did on load: the
  // trailing-paragraph and cloze-numbering rules run now, silently, rather
  // than on the first click — which would otherwise count as an edit.
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta('preventUpdate', true).setMeta('addToHistory', false));

    const pending = activation.current;
    activation.current = null;
    if (!pending) return;
    if (pending.replay) {
      // Next frame: the editor's React node views (a formula, an image's
      // buttons) are drawn by a render that follows this one.
      const at = pending.replay;
      const frame = requestAnimationFrame(() => {
        if (!editor.isDestroyed) replayClick(editor, at);
      });
      return () => cancelAnimationFrame(frame);
    }
    placeSelection(editor, pending);
    // Node views (links, formulas) fill in a frame later and can shift the
    // text; if nothing has moved the cursor since — not a key, and not the
    // second click of a double-click — place it again against the settled
    // layout.
    const placed = editor.state.selection;
    let touched = false;
    const onPointer = () => {
      touched = true;
    };
    const dom = editor.view.dom;
    dom.addEventListener('mousedown', onPointer);
    const frame = requestAnimationFrame(() => {
      dom.removeEventListener('mousedown', onPointer);
      if (!touched && !editor.isDestroyed && editor.state.selection.eq(placed)) placeSelection(editor, pending);
    });
    return () => {
      cancelAnimationFrame(frame);
      dom.removeEventListener('mousedown', onPointer);
    };
    // Only when the editor instance is created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Keep the editor in step with changes from elsewhere (a merge, a sync, the
  // same rem edited in the other pane) — but never while you are typing in it.
  const serialized = useMemo(() => JSON.stringify(doc), [doc]);
  const shown = useRef(serialized);
  useEffect(() => {
    if (!editor || editor.isDestroyed || editor.isFocused || serialized === shown.current) return;
    shown.current = serialized;
    if (JSON.stringify(editor.getJSON()) !== serialized) {
      editor.commands.setContent(JSON.parse(serialized) as DocNode, { emitUpdate: false });
    }
  }, [editor, serialized]);

  /**
   * Focus this row when asked to. The editor can exist a frame or two before
   * its view is in the document — a row that has just been created, or
   * remounted under a new parent by an outdent, or a page that has just been
   * navigated to — and focusing it then silently does nothing, leaving the
   * cursor on <body>. So wait for the view to be attached, briefly.
   *
   * An editor that already has focus — because you clicked into it — is left
   * alone: moving its cursor to the end would undo where you clicked.
   */
  useEffect(() => {
    if (focusedNodeId !== nodeId || !editor) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      if (editor.isDestroyed) return;
      if (editor.isFocused) {
        takeFocusIntent(nodeId);
        return;
      }
      let attached = false;
      try {
        attached = editor.view.dom.isConnected;
      } catch {
        // Tiptap throws on `view` before the editor has mounted.
      }
      if (attached) {
        editor.commands.focus(takeFocusIntent(nodeId));
      } else if (tries++ < 20) {
        frame = requestAnimationFrame(attempt);
      }
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [focusedNodeId, nodeId, editor]);

  return <EditorContent editor={editor} className="rem-live-host" />;
}

function placeSelection(editor: Editor, pending: Activation): void {
  const view = editor.view;
  const anchor = view.posAtCoords({ left: pending.anchor.x, top: pending.anchor.y });
  const head = view.posAtCoords({ left: pending.head.x, top: pending.head.y });
  view.focus();
  if (!anchor || !head) return;
  const { doc } = view.state;
  const selection = TextSelection.between(doc.resolve(anchor.pos), doc.resolve(head.pos));
  view.dispatch(view.state.tr.setSelection(selection));
}

/** Send the click that opened the editor to the same spot in it. */
function replayClick(editor: Editor, at: { x: number; y: number; shiftKey: boolean }): void {
  const target = document.elementFromPoint(at.x, at.y);
  if (!(target instanceof HTMLElement) || !editor.view.dom.contains(target)) return;
  const checkbox = target.closest('label')?.querySelector('input[type="checkbox"]');
  if (checkbox instanceof HTMLInputElement) {
    checkbox.click();
    return;
  }
  target.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, shiftKey: at.shiftKey })
  );
}
