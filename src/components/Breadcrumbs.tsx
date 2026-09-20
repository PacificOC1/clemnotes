import { useState } from 'react';
import type { OutlinerNode } from '../db/schema';

/**
 * The path from the page down to the rem you are zoomed into.
 *
 * A deep trail used to run off the end of the topbar and push "New page" out
 * of reach, because each crumb capped its own width but the trail itself never
 * collapsed. Past a few levels the middle folds into a `…` — the root and the
 * last two are the ones that carry meaning, and everything else is still one
 * click away behind the menu.
 */

/** Crumbs shown at the end of a collapsed trail, after the root and the `…`. */
const TAIL = 2;

interface BreadcrumbsProps {
  path: OutlinerNode[];
  onNavigate: (nodeId: string) => void;
}

function label(node: OutlinerNode): string {
  return node.plainText.trim() || 'Untitled';
}

export function Breadcrumbs({ path, onNavigate }: BreadcrumbsProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  if (path.length <= 1) return null;

  const collapsed = path.length > TAIL + 2;
  const hidden = collapsed ? path.slice(1, path.length - TAIL) : [];
  const shown = collapsed ? [path[0]!, ...path.slice(path.length - TAIL)] : path;

  return (
    <nav className="breadcrumbs">
      {shown.map((node, i) => {
        const isLast = i === shown.length - 1;
        return (
          <span key={node.id} className="breadcrumb-item">
            <span
              className={`breadcrumb-label ${isLast ? 'current' : ''}`}
              onClick={() => !isLast && onNavigate(node.id)}
            >
              {label(node)}
            </span>
            {!isLast && <span className="breadcrumb-separator">/</span>}
            {collapsed && i === 0 && (
              <span className="breadcrumb-more">
                <button
                  type="button"
                  className="breadcrumb-ellipsis"
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-expanded={menuOpen}
                  title={`${hidden.length} more level${hidden.length === 1 ? '' : 's'}`}
                >
                  …
                </button>
                <span className="breadcrumb-separator">/</span>
                {menuOpen && (
                  <span className="breadcrumb-menu">
                    {hidden.map((skipped) => (
                      <button
                        key={skipped.id}
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          onNavigate(skipped.id);
                        }}
                      >
                        {label(skipped)}
                      </button>
                    ))}
                  </span>
                )}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
