import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getVersions, markConflictsSeen } from '../db/versionRepository';
import { getNode, restoreVersion } from '../db/repository';
import { parseDoc } from '../tiptap/docUtils';
import { ReadOnlyDoc } from './ReadOnlyDoc';
import type { RemVersion } from '../db/schema';

interface Props {
  nodeId: string;
  onClose: () => void;
}

function when(savedAt: number): string {
  const diff = Date.now() - savedAt;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(savedAt).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function reasonLabel(version: RemVersion): string {
  if (version.reason === 'conflict') {
    return version.from === 'another device' ? 'From another device' : 'From this device';
  }
  return version.reason === 'restore' ? 'Before a restore' : 'Before an edit';
}

/**
 * One rem's past versions, with a preview and a restore button.
 *
 * Conflict versions are the reason this has to be easy to reach: they are the
 * text a sync would otherwise have thrown away, and opening the history marks
 * them as seen so the sidebar stops pointing at them.
 */
export function VersionHistory({ nodeId, onClose }: Props) {
  const node = useLiveQuery(() => getNode(nodeId), [nodeId]);
  const versions = useLiveQuery(() => getVersions(nodeId), [nodeId]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void markConflictsSeen(nodeId);
  }, [nodeId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const selected = versions?.find((v) => v.id === selectedId) ?? versions?.[0] ?? null;

  async function handleRestore(version: RemVersion) {
    setBusy(true);
    try {
      await restoreVersion(version);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="history-backdrop" onClick={onClose} role="presentation">
      <div
        className="history"
        role="dialog"
        aria-modal="true"
        aria-label="Version history"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>Version history</h2>
            <p>{node?.plainText.trim() || 'Untitled'}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {versions === undefined ? null : versions.length === 0 ? (
          <p className="history-empty">
            No earlier versions yet. One is kept each time you come back to edit this rem after a
            pause of ten minutes or more, and whenever a sync would have overwritten it.
          </p>
        ) : (
          <div className="history-body">
            <ul className="history-list">
              {versions.map((version) => (
                <li key={version.id}>
                  <button
                    type="button"
                    className={`${version.id === selected?.id ? 'active' : ''} ${version.reason === 'conflict' ? 'is-conflict' : ''}`}
                    onClick={() => setSelectedId(version.id)}
                  >
                    <span className="history-when">{when(version.savedAt)}</span>
                    <span className="history-reason">{reasonLabel(version)}</span>
                    <span className="history-snippet">{version.plainText.trim() || '(empty)'}</span>
                  </button>
                </li>
              ))}
            </ul>
            {selected && (
              <div className="history-preview">
                <div className="history-preview-label">
                  {reasonLabel(selected)} · {new Date(selected.savedAt).toLocaleString()}
                </div>
                <ReadOnlyDoc doc={parseDoc(selected.content)} className="history-doc" />
                <div className="history-actions">
                  <button
                    type="button"
                    className="primary-btn"
                    disabled={busy || selected.content === node?.content}
                    onClick={() => void handleRestore(selected)}
                  >
                    {selected.content === node?.content ? 'This is the current text' : 'Restore this version'}
                  </button>
                  <span className="history-note">The current text is kept as a version first.</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
