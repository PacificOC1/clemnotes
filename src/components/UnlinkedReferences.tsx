import { useEffect, useState } from 'react';
import { getUnlinkedReferences, linkMention, type UnlinkedReference } from '../db/unlinked';

interface Props {
  nodeId: string;
  onZoomTo: (nodeId: string) => void;
}

/**
 * "Unlinked references" — rems that mention this one by name without linking
 * to it, each with a button that turns the mention into a link.
 *
 * Folded until asked for: finding them is a search across the notebook, and
 * most of the time you are here to write, not to garden links.
 */
export function UnlinkedReferences({ nodeId, onZoomTo }: Props) {
  const [open, setOpen] = useState(false);
  const [refs, setRefs] = useState<UnlinkedReference[] | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getUnlinkedReferences(nodeId).then((found) => {
      if (!cancelled) setRefs(found);
    });
    return () => {
      cancelled = true;
    };
  }, [open, nodeId, version]);

  async function link(sourceId: string) {
    await linkMention(sourceId, nodeId);
    setVersion((v) => v + 1);
  }

  async function linkAll() {
    for (const ref of refs ?? []) await linkMention(ref.node.id, nodeId);
    setVersion((v) => v + 1);
  }

  const shown = open && refs && refs.length > 0 ? refs : null;

  return (
    <div className="unlinked-panel">
      <button type="button" className="unlinked-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{open ? '▾' : '▸'}</span> Unlinked references
        {open && refs !== null && <span className="unlinked-count"> ({refs.length})</span>}
      </button>
      {open && refs !== null && refs.length === 0 && (
        <p className="unlinked-empty">Nothing else mentions this by name without linking to it.</p>
      )}
      {shown && (
        <>
          {shown.length > 1 && (
            <button type="button" className="link-btn unlinked-all" onClick={() => void linkAll()}>
              Link all {shown.length}
            </button>
          )}
          <ul>
            {shown.map(({ node, sourcePage }) => (
              <li key={node.id}>
                <button type="button" className="unlinked-main" onClick={() => onZoomTo(node.id)}>
                  {sourcePage && sourcePage.id !== node.id && (
                    <span className="backlink-source">in {sourcePage.plainText || 'Untitled'}</span>
                  )}
                  <span className="backlink-snippet">{node.plainText}</span>
                </button>
                <button type="button" className="unlinked-link" onClick={() => void link(node.id)}>
                  Link
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
