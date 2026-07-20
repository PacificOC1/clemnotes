import { useState, useRef, useEffect } from 'react';
import { useActiveEditor } from '../context/ActiveEditorContext';

export function BottomToolbar() {
  const { activeEditor } = useActiveEditor();
  const [showHeadingMenu, setShowHeadingMenu] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowHeadingMenu(false);
        setShowMoreMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const disabled = !activeEditor;

  function run(fn: (editor: NonNullable<typeof activeEditor>) => void) {
    if (!activeEditor) return;
    fn(activeEditor);
    setShowHeadingMenu(false);
    setShowMoreMenu(false);
  }

  return (
    <div className="bottom-toolbar" ref={containerRef}>
      <div className="toolbar-item toolbar-dropdown-wrapper">
        <button
          className="toolbar-btn"
          disabled={disabled}
          onClick={() => setShowHeadingMenu((v) => !v)}
        >
          <span className="toolbar-icon">H↕</span>
          <span className="toolbar-label">Heading</span>
        </button>
        {showHeadingMenu && (
          <div className="toolbar-dropdown">
            {[1, 2, 3].map((level) => (
              <button
                key={level}
                onClick={() =>
                  run((editor) =>
                    editor
                      .chain()
                      .focus()
                      .toggleHeading({ level: level as 1 | 2 | 3 })
                      .run()
                  )
                }
              >
                Heading {level}
              </button>
            ))}
            <button onClick={() => run((editor) => editor.chain().focus().setParagraph().run())}>
              Normal text
            </button>
          </div>
        )}
      </div>

      <button
        className="toolbar-btn"
        disabled={disabled}
        onClick={() => run((editor) => editor.chain().focus().toggleTaskList().run())}
      >
        <span className="toolbar-icon">☑</span>
        <span className="toolbar-label">Todo</span>
      </button>

      <button
        className="toolbar-btn"
        disabled={disabled}
        onClick={() =>
          run((editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())
        }
      >
        <span className="toolbar-icon">⊞</span>
        <span className="toolbar-label">Table</span>
      </button>

      <div className="toolbar-item toolbar-dropdown-wrapper">
        <button className="toolbar-btn" disabled={disabled} onClick={() => setShowMoreMenu((v) => !v)}>
          <span className="toolbar-icon">+</span>
          <span className="toolbar-label">More</span>
        </button>
        {showMoreMenu && (
          <div className="toolbar-dropdown">
            <button onClick={() => run((editor) => editor.chain().focus().toggleBold().run())}>Bold</button>
            <button onClick={() => run((editor) => editor.chain().focus().toggleItalic().run())}>Italic</button>
            <button onClick={() => run((editor) => editor.chain().focus().toggleStrike().run())}>Strikethrough</button>
            <button onClick={() => run((editor) => editor.chain().focus().toggleCode().run())}>Inline code</button>
            <button onClick={() => run((editor) => editor.chain().focus().toggleCodeBlock().run())}>Code block</button>
          </div>
        )}
      </div>

      <button
        className="toolbar-btn"
        disabled={disabled}
        onClick={() => run((editor) => editor.chain().focus().undo().run())}
      >
        <span className="toolbar-icon">↩</span>
        <span className="toolbar-label">Undo</span>
      </button>
    </div>
  );
}
