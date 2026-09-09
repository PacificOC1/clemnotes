import { useLiveQuery } from 'dexie-react-hooks';
import { getBacklinks, findRootPage } from '../db/repository';
import { useEffect, useState } from 'react';
import type { OutlinerNode } from '../db/schema';

interface BacklinksPanelProps {
  nodeId: string;
  onZoomTo: (nodeId: string) => void;
}

interface BacklinkEntry {
  node: OutlinerNode;
  sourcePage: OutlinerNode | undefined;
}

export function BacklinksPanel({ nodeId, onZoomTo }: BacklinksPanelProps) {
  // Deliberately not defaulted to `[]`: while the query is still resolving,
  // `?? []` hands the effect below a brand-new array on every render, and the
  // effect's own setState causes that render — a spin that only stopped when
  // Dexie happened to answer.
  const backlinkNodes = useLiveQuery(() => getBacklinks(nodeId), [nodeId]);
  const [entries, setEntries] = useState<BacklinkEntry[]>([]);

  useEffect(() => {
    if (!backlinkNodes) return;
    let cancelled = false;
    (async () => {
      const resolved = await Promise.all(
        backlinkNodes.map(async (node) => ({
          node,
          sourcePage: await findRootPage(node.id),
        }))
      );
      // Keep the old array when both are empty, so an empty result can't
      // re-trigger this effect through a changed state identity.
      if (!cancelled) {
        setEntries((prev) => (prev.length === 0 && resolved.length === 0 ? prev : resolved));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backlinkNodes]);

  if (entries.length === 0) return null;

  return (
    <div className="backlinks-panel">
      <h3>Linked References ({entries.length})</h3>
      <ul>
        {entries.map(({ node, sourcePage }) => (
          <li key={node.id} onClick={() => onZoomTo(node.id)}>
            {sourcePage && sourcePage.id !== node.id && (
              <div className="backlink-source">in {sourcePage.plainText || 'Untitled'}</div>
            )}
            <div className="backlink-snippet">{node.plainText}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
