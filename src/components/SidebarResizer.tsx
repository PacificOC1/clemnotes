import { useRef } from 'react';

interface Props {
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}

/**
 * The sidebar's right edge, draggable (#41). Pointer events rather than HTML5
 * drag-and-drop, so it also works with a pen or a finger; double-click puts it
 * back to the default width; arrow keys nudge it for keyboard users.
 */
export function SidebarResizer({ width, min, max, defaultWidth, onResize, onCommit }: Props) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const latest = useRef(width);
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));

  function set(next: number) {
    latest.current = clamp(next);
    onResize(latest.current);
  }

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(event) => {
        event.preventDefault();
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width };
        document.body.classList.add('is-resizing');
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        set(start.current.width + event.clientX - start.current.x);
      }}
      onPointerUp={() => {
        if (!start.current) return;
        start.current = null;
        document.body.classList.remove('is-resizing');
        onCommit(latest.current);
      }}
      onDoubleClick={() => {
        set(defaultWidth);
        onCommit(latest.current);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        set(width + (event.key === 'ArrowRight' ? 16 : -16));
        onCommit(latest.current);
      }}
    />
  );
}
