import { useEffect, useRef, useState } from 'react';
import { useActiveEditor } from '../context/ActiveEditorContext';

const FONT_FAMILIES = [['Helvetica', 'Helvetica'], ['Arial', 'Arial'], ['Georgia', 'Georgia'], ['Times New Roman', 'Times New Roman'], ['Verdana', 'Verdana'], ['Courier New', 'Courier New']] as const;
const FONT_SIZES = [12, 14, 15, 16, 18, 20, 24, 28, 32, 36];
const TABLE_GRID_DIMENSION = 8;
const TABLE_SIZES = Array.from({ length: TABLE_GRID_DIMENSION }, (_, rowIndex) =>
  Array.from({ length: TABLE_GRID_DIMENSION }, (_, colIndex) => ({ rows: rowIndex + 1, cols: colIndex + 1 }))
).flat();

export function BottomToolbar() {
  const { activeEditor } = useActiveEditor();
  const [hasSelection, setHasSelection] = useState(false);
  const [inTable, setInTable] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showTableMenu, setShowTableMenu] = useState(false);
  const [tableSizePreview, setTableSizePreview] = useState<{ rows: number; cols: number } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const disabled = !activeEditor;

  useEffect(() => {
    if (!activeEditor) { setHasSelection(false); setInTable(false); return; }
    const updateState = () => {
      setHasSelection(!activeEditor.state.selection.empty);
      setInTable(activeEditor.isActive('table'));
    };
    updateState();
    activeEditor.on('selectionUpdate', updateState);
    activeEditor.on('transaction', updateState);
    return () => {
      activeEditor.off('selectionUpdate', updateState);
      activeEditor.off('transaction', updateState);
    };
  }, [activeEditor]);

  useEffect(() => {
    const closeMenus = (event: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(event.target as Node)) {
        setShowMoreMenu(false);
        setShowTableMenu(false);
      }
    };
    document.addEventListener('mousedown', closeMenus);
    return () => document.removeEventListener('mousedown', closeMenus);
  }, []);

  function run(fn: (editor: NonNullable<typeof activeEditor>) => void) {
    if (!activeEditor) return;
    fn(activeEditor);
    setShowMoreMenu(false);
    setShowTableMenu(false);
  }

  return (
    <div className="bottom-toolbar" aria-label="Editor toolbar" ref={toolbarRef}>
      {hasSelection && <>
        <select className="toolbar-select toolbar-font-family" aria-label="Font family" disabled={disabled} defaultValue="Helvetica" onChange={(event) => run((editor) => editor.chain().focus().setFontFamily(event.target.value).run())}>
          {FONT_FAMILIES.map(([label, value]) => <option key={value} value={value} style={{ fontFamily: value }}>{label}</option>)}
        </select>
        <select className="toolbar-select toolbar-font-size" aria-label="Font size" disabled={disabled} defaultValue="15" onChange={(event) => run((editor) => editor.chain().focus().setMark('textStyle', { fontSize: `${event.target.value}px` }).run())}>
          {FONT_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
        <select className="toolbar-select toolbar-style" aria-label="Paragraph style" disabled={disabled} defaultValue="paragraph" onChange={(event) => run((editor) => { const value = event.target.value; if (value === 'paragraph') editor.chain().focus().setParagraph().run(); else editor.chain().focus().setHeading({ level: Number(value) as 1 | 2 | 3 | 4 | 5 | 6 }).run(); })}>
          <option value="paragraph">Normal</option><option value="1">Heading 1</option><option value="2">Heading 2</option><option value="3">Heading 3</option><option value="4">Heading 4</option><option value="5">Heading 5</option><option value="6">Heading 6</option>
        </select>
        <span className="toolbar-divider" />
        <button className="toolbar-icon-btn" disabled={disabled} onClick={() => run((e) => e.chain().focus().toggleBold().run())} title="Bold"><strong>B</strong></button>
        <button className="toolbar-icon-btn toolbar-italic" disabled={disabled} onClick={() => run((e) => e.chain().focus().toggleItalic().run())} title="Italic">I</button>
        <button className="toolbar-icon-btn" disabled={disabled} onClick={() => run((e) => e.chain().focus().toggleUnderline().run())} title="Underline"><u>U</u></button>
        <button className="toolbar-icon-btn" disabled={disabled} onClick={() => run((e) => e.chain().focus().toggleStrike().run())} title="Strikethrough"><s>S</s></button>
        <label className="toolbar-color" title="Text colour"><span>A</span><input type="color" aria-label="Text colour" disabled={disabled} defaultValue="#e4e4e7" onChange={(event) => run((e) => e.chain().focus().setColor(event.target.value).run())} /></label>
        <label className="toolbar-highlight" title="Highlight colour"><span>▰</span><input type="color" aria-label="Highlight colour" disabled={disabled} defaultValue="#e0b25e" onChange={(event) => run((e) => e.chain().focus().toggleHighlight({ color: event.target.value }).run())} /></label>
        <span className="toolbar-divider" />
        <button className="toolbar-icon-btn" disabled={disabled} onClick={() => run((e) => e.chain().focus().setTextAlign('left').run())} title="Align left">≡</button>
        <button className="toolbar-icon-btn" disabled={disabled} onClick={() => run((e) => e.chain().focus().setTextAlign('center').run())} title="Align centre">≡</button>
        <button className="toolbar-icon-btn toolbar-align-right" disabled={disabled} onClick={() => run((e) => e.chain().focus().setTextAlign('right').run())} title="Align right">≡</button>
        <span className="toolbar-divider" />
      </>}

      <button className="toolbar-btn" disabled={disabled} onClick={() => run((e) => e.chain().focus().toggleTaskList().run())}><span className="toolbar-icon">☑</span><span className="toolbar-label">Todo</span></button>
      <div className="toolbar-item toolbar-dropdown-wrapper">
        <button className="toolbar-btn" disabled={disabled} onClick={() => { setShowTableMenu((value) => !value); setShowMoreMenu(false); setTableSizePreview(null); }}><span className="toolbar-icon">⊞</span><span className="toolbar-label">Table</span></button>
        {showTableMenu && <div className="toolbar-dropdown table-dropdown">
          <div className="table-menu-heading">{tableSizePreview ? `${tableSizePreview.cols} × ${tableSizePreview.rows} table` : 'Insert table'}</div>
          <div className="table-size-grid" onMouseLeave={() => setTableSizePreview(null)}>{TABLE_SIZES.map(({ rows, cols }) => {
            const selected = tableSizePreview && rows <= tableSizePreview.rows && cols <= tableSizePreview.cols;
            return <button key={`${rows}x${cols}`} className={`table-size-option ${selected ? 'selected' : ''}`} aria-label={`Insert ${cols} columns by ${rows} rows table`} onMouseEnter={() => setTableSizePreview({ rows, cols })} onFocus={() => setTableSizePreview({ rows, cols })} onClick={() => run((e) => e.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run())} />;
          })}</div>
          <div className="table-menu-heading">Current table {!inTable && '(select a table cell to enable)'}</div><div className="table-action-grid">
            <button disabled={!inTable} onClick={() => run((e) => e.chain().focus().addRowBefore().run())}>Add row above</button><button disabled={!inTable} onClick={() => run((e) => e.chain().focus().addRowAfter().run())}>Add row below</button>
            <button disabled={!inTable} onClick={() => run((e) => e.chain().focus().addColumnBefore().run())}>Add column left</button><button disabled={!inTable} onClick={() => run((e) => e.chain().focus().addColumnAfter().run())}>Add column right</button>
            <button disabled={!inTable} onClick={() => run((e) => e.chain().focus().deleteRow().run())}>Delete row</button><button disabled={!inTable} onClick={() => run((e) => e.chain().focus().deleteColumn().run())}>Delete column</button>
            <button disabled={!inTable} onClick={() => run((e) => e.chain().focus().toggleHeaderRow().run())}>Toggle header row</button><button disabled={!inTable} onClick={() => run((e) => e.chain().focus().toggleHeaderColumn().run())}>Toggle header column</button>
            <button disabled={!inTable} onClick={() => run((e) => e.chain().focus().mergeCells().run())}>Merge cells</button><button disabled={!inTable} onClick={() => run((e) => e.chain().focus().splitCell().run())}>Split cell</button>
            <button disabled={!inTable} className="table-delete-btn" onClick={() => run((e) => e.chain().focus().deleteTable().run())}>Delete table</button>
          </div>
        </div>}
      </div>
      <div className="toolbar-item toolbar-dropdown-wrapper">
        <button className="toolbar-btn" disabled={disabled} onClick={() => { setShowMoreMenu((value) => !value); setShowTableMenu(false); }}><span className="toolbar-icon">+</span><span className="toolbar-label">More</span></button>
        {showMoreMenu && <div className="toolbar-dropdown"><button onClick={() => run((e) => e.chain().focus().toggleBulletList().run())}>Bullet list</button><button onClick={() => run((e) => e.chain().focus().toggleOrderedList().run())}>Numbered list</button><button onClick={() => run((e) => e.chain().focus().toggleCode().run())}>Inline code</button><button onClick={() => run((e) => e.chain().focus().toggleCodeBlock().run())}>Code block</button><button onClick={() => run((e) => e.chain().focus().unsetAllMarks().clearNodes().run())}>Clear formatting</button></div>}
      </div>
      <button className="toolbar-btn" disabled={disabled} onClick={() => run((e) => e.chain().focus().undo().run())}><span className="toolbar-icon">↶</span><span className="toolbar-label">Undo</span></button>
    </div>
  );
}
