import { useEffect, useRef, useState } from 'react';
import { useActiveEditor } from '../context/ActiveEditorContext';
import { isMenuOpen } from '../editor/menuStore';
import { maxClozeIndex, type DocNode } from '../tiptap/docUtils';

const FONT_FAMILIES = ['Inter', 'Georgia', 'Helvetica', 'Times New Roman', 'Courier New'];
const FONT_SIZES = [12, 14, 15, 16, 18, 20, 24, 32];
const HIGHLIGHTS = ['#f2c14e', '#7bc86c', '#68b7f0', '#f08c8c', '#c19bf0'];

interface Box {
  left: number;
  top: number;
}

/**
 * A floating toolbar that appears over the current text selection, replacing
 * the old always-on bottom bar. It reads the app's single "active editor"
 * rather than mounting a Tiptap BubbleMenu inside every bullet — with one
 * editor instance per rem, per-row menus would mean hundreds of plugins for a
 * toolbar only ever visible once.
 */
export function FormattingBubble() {
  const { activeEditor } = useActiveEditor();
  const [box, setBox] = useState<Box | null>(null);
  const [showType, setShowType] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [, forceRender] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeEditor) {
      setBox(null);
      return;
    }

    function update() {
      const editor = activeEditor;
      if (!editor || editor.isDestroyed) return;
      const { state, view } = editor;
      const { selection } = state;

      if (selection.empty || !editor.isFocused || isMenuOpen()) {
        setBox(null);
        setShowType(false);
        setShowMore(false);
        return;
      }

      const start = view.coordsAtPos(selection.from);
      const end = view.coordsAtPos(selection.to);
      const left = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2;
      setBox({ left, top: Math.min(start.top, end.top) });
      forceRender((n) => n + 1);
    }

    update();
    activeEditor.on('selectionUpdate', update);
    activeEditor.on('transaction', update);
    activeEditor.on('blur', update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      activeEditor.off('selectionUpdate', update);
      activeEditor.off('transaction', update);
      activeEditor.off('blur', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [activeEditor]);

  if (!activeEditor || !box) return null;
  const editor = activeEditor;

  function run(fn: () => void) {
    fn();
    setShowType(false);
    setShowMore(false);
  }

  /** Turn the selected words into a numbered cloze blank — one new card. */
  function makeCloze() {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, ' ').trim();
    if (!text) return;
    const index = maxClozeIndex(editor.getJSON() as DocNode) + 1;
    editor
      .chain()
      .focus()
      .deleteRange({ from, to })
      .insertContent({ type: 'cloze', attrs: { index, text } })
      .run();
  }

  const active = (name: string, attrs?: Record<string, unknown>) =>
    editor.isActive(name, attrs) ? 'active' : '';

  const typeLabel = editor.isActive('heading', { level: 1 })
    ? 'H1'
    : editor.isActive('heading', { level: 2 })
      ? 'H2'
      : editor.isActive('heading', { level: 3 })
        ? 'H3'
        : 'Text';

  return (
    <div
      ref={ref}
      className="format-bubble"
      style={{ left: box.left, top: box.top - 12 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="format-bubble-group">
        <button
          type="button"
          className="fb-btn fb-type"
          onClick={() => { setShowType((v) => !v); setShowMore(false); }}
        >
          {typeLabel} <span className="fb-caret">▾</span>
        </button>
        {showType && (
          <div className="fb-dropdown">
            <button type="button" onClick={() => run(() => editor.chain().focus().setParagraph().run())}>Normal text</button>
            <button type="button" onClick={() => run(() => editor.chain().focus().setHeading({ level: 1 }).run())}>Heading 1</button>
            <button type="button" onClick={() => run(() => editor.chain().focus().setHeading({ level: 2 }).run())}>Heading 2</button>
            <button type="button" onClick={() => run(() => editor.chain().focus().setHeading({ level: 3 }).run())}>Heading 3</button>
            <button type="button" onClick={() => run(() => editor.chain().focus().toggleBlockquote().run())}>Quote</button>
            <button type="button" onClick={() => run(() => editor.chain().focus().toggleCodeBlock().run())}>Code block</button>
          </div>
        )}
      </div>

      <span className="fb-divider" />

      <button type="button" className={`fb-btn ${active('bold')}`} title="Bold  ⌘B" onClick={() => run(() => editor.chain().focus().toggleBold().run())}><strong>B</strong></button>
      <button type="button" className={`fb-btn fb-italic ${active('italic')}`} title="Italic  ⌘I" onClick={() => run(() => editor.chain().focus().toggleItalic().run())}>I</button>
      <button type="button" className={`fb-btn ${active('underline')}`} title="Underline  ⌘U" onClick={() => run(() => editor.chain().focus().toggleUnderline().run())}><u>U</u></button>
      <button type="button" className={`fb-btn ${active('strike')}`} title="Strikethrough" onClick={() => run(() => editor.chain().focus().toggleStrike().run())}><s>S</s></button>
      <button type="button" className={`fb-btn ${active('code')}`} title="Inline code" onClick={() => run(() => editor.chain().focus().toggleCode().run())}>{'</>'}</button>

      <span className="fb-divider" />

      <div className="format-bubble-group">
        <button type="button" className="fb-btn fb-swatch-btn" title="Highlight" onClick={() => { setShowMore((v) => !v); setShowType(false); }}>
          <span className="fb-swatch" />
        </button>
        {showMore && (
          <div className="fb-dropdown fb-dropdown-wide">
            <div className="fb-row-label">Highlight</div>
            <div className="fb-swatches">
              {HIGHLIGHTS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="fb-swatch-option"
                  style={{ background: color }}
                  aria-label={`Highlight ${color}`}
                  onClick={() => run(() => editor.chain().focus().toggleHighlight({ color }).run())}
                />
              ))}
              <button type="button" className="fb-swatch-option fb-swatch-none" aria-label="No highlight" onClick={() => run(() => editor.chain().focus().unsetHighlight().run())}>×</button>
            </div>
            <div className="fb-row-label">Text colour</div>
            <div className="fb-swatches">
              {['#e6e6ea', '#f08c8c', '#7bc86c', '#68b7f0', '#c19bf0'].map((color) => (
                <button
                  key={color}
                  type="button"
                  className="fb-swatch-option"
                  style={{ background: color }}
                  aria-label={`Text colour ${color}`}
                  onClick={() => run(() => editor.chain().focus().setColor(color).run())}
                />
              ))}
              <button type="button" className="fb-swatch-option fb-swatch-none" aria-label="Default colour" onClick={() => run(() => editor.chain().focus().unsetColor().run())}>×</button>
            </div>
            <div className="fb-row-label">Font</div>
            <select
              className="fb-select"
              defaultValue=""
              onChange={(e) => run(() => editor.chain().focus().setFontFamily(e.target.value).run())}
            >
              <option value="" disabled>Family…</option>
              {FONT_FAMILIES.map((family) => <option key={family} value={family}>{family}</option>)}
            </select>
            <select
              className="fb-select"
              defaultValue=""
              onChange={(e) => run(() => editor.chain().focus().setMark('textStyle', { fontSize: `${e.target.value}px` }).run())}
            >
              <option value="" disabled>Size…</option>
              {FONT_SIZES.map((size) => <option key={size} value={size}>{size}px</option>)}
            </select>
            <div className="fb-row-label">Align</div>
            <div className="fb-swatches">
              <button type="button" className="fb-mini" onClick={() => run(() => editor.chain().focus().setTextAlign('left').run())}>Left</button>
              <button type="button" className="fb-mini" onClick={() => run(() => editor.chain().focus().setTextAlign('center').run())}>Centre</button>
              <button type="button" className="fb-mini" onClick={() => run(() => editor.chain().focus().setTextAlign('right').run())}>Right</button>
            </div>
          </div>
        )}
      </div>

      <span className="fb-divider" />

      <button type="button" className="fb-btn fb-cloze" title="Make this a cloze blank" onClick={() => run(makeCloze)}>⌷</button>
      <button type="button" className="fb-btn" title="Clear formatting" onClick={() => run(() => editor.chain().focus().unsetAllMarks().run())}>⌫</button>
    </div>
  );
}
