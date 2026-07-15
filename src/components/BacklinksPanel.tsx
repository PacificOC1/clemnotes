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
  const backlinkNodes = useLiveQuery(() => getBacklinks(nodeId), [nodeId]) ?? [];
  const [entries, setEntries] = useState<BacklinkEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const resolved = await Promise.all(
        backlinkNodes.map(async (node) => ({
          node,
          sourcePage: await findRootPage(node.id),
        }))
      );
      if (!cancelled) setEntries(resolved);
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
