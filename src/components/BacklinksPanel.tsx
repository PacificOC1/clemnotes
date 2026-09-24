import { useLiveQuery } from 'dexie-react-hooks';
import { getBacklinks, findRootPage, getNode } from '../db/repository';
import { remHasTag } from '../db/tags';
import { useEffect, useState } from 'react';
import type { OutlinerNode } from '../db/schema';

interface BacklinksPanelProps {
  nodeId: string;
  onZoomTo: (nodeId: string) => void;
}

interface BacklinkEntry {
  node: OutlinerNode;
  sourcePage: OutlinerNode | undefined;
  /** Got here by `#tag` rather than by `[[link]]` — listed separately. */
  tagged: boolean;
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
      const self = await getNode(nodeId);
      const ids = new Set([nodeId]);
      const names = new Set(self ? [self.plainText.trim().toLowerCase()] : []);
      const resolved = await Promise.all(
        backlinkNodes.map(async (node) => ({
          node,
          sourcePage: await findRootPage(node.id),
          tagged: remHasTag(node, ids, names),
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
  }, [backlinkNodes, nodeId]);

  if (entries.length === 0) return null;

  // A rem that both tags and links here is listed once, under Tagged: the tag
  // is the more deliberate statement of the two.
  const tagged = entries.filter((e) => e.tagged);
  const linked = entries.filter((e) => !e.tagged);

  const list = (items: BacklinkEntry[]) => (
    <ul>
      {items.map(({ node, sourcePage }) => (
        <li key={node.id} onClick={() => onZoomTo(node.id)}>
          {sourcePage && sourcePage.id !== node.id && (
            <div className="backlink-source">in {sourcePage.plainText || 'Untitled'}</div>
          )}
          <div className="backlink-snippet">{node.plainText}</div>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="backlinks-panel">
      {tagged.length > 0 && (
        <>
          <h3>Tagged ({tagged.length})</h3>
          {list(tagged)}
        </>
      )}
      {linked.length > 0 && (
        <>
          <h3>Linked References ({linked.length})</h3>
          {list(linked)}
        </>
      )}
    </div>
  );
}
