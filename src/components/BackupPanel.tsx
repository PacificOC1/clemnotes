import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/database';
import { backupFilename, backupFromTables, buildBackup, serializeBackup } from '../export/backup';
import { getSnapshot, listSnapshots } from '../db/migrationSafety';
import { ImportSection } from './ImportSection';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { deleteImagesLocally, findUnusedImages } from '../db/imageRepository';
import { removeFromStorage } from '../sync/imageSync';
import { logEvent } from '../diagnostics';
import { downloadText, timestampSlug } from '../export/download';
import { importBackup, isFromNewerSchema, parseBackup, type ImportReport } from '../export/importBackup';
import { pagesToMarkdown } from '../export/markdown';
import { buildExportTrees } from '../export/tree';

type Busy = 'json' | 'markdown' | 'import' | 'sweep' | null;

/**
 * Export, backup and restore.
 *
 * Sits under the sync panel because the two answer the same question — "where
 * does my writing actually live?" — from opposite ends: sync is the copy you
 * don't have to think about, this is the copy you can hold.
 */
export function BackupPanel() {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const noteCount = useLiveQuery(
    async () => (await db.nodes.toArray()).filter((n) => n.deletedAt === null).length,
    []
  );

  // Only read while the panel is open: it is a second database, and nothing
  // about it changes while you are looking at something else.
  const snapshots = useLiveQuery(
    () => (expanded ? listSnapshots() : Promise.resolve([])),
    [expanded]
  );

  function report(text: string) {
    setError(null);
    setMessage(text);
  }

  async function handleExportJson() {
    setBusy('json');
    try {
      const backup = await buildBackup();
      downloadText(backupFilename(backup.exportedAt), serializeBackup(backup), 'application/json');
      const { nodes, cards, reviews } = backup.counts;
      report(`Exported ${nodes} rems, ${cards} cards, ${reviews} reviews.`);
    } catch (err) {
      setMessage(null);
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  }

  async function handleExportMarkdown() {
    setBusy('markdown');
    try {
      const trees = await buildExportTrees();
      if (trees.length === 0) {
        setMessage(null);
        setError('There are no pages to export yet.');
        return;
      }
      downloadText(`clemnotes-notes-${timestampSlug()}.md`, pagesToMarkdown(trees), 'text/markdown');
      report(`Exported ${trees.length} page${trees.length === 1 ? '' : 's'} as Markdown.`);
    } catch (err) {
      setMessage(null);
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Remove images no rem, deleted rem or kept version refers to any more —
   * here, and in cloud storage when signed in. Asks first, with the numbers.
   */
  async function handleSweepImages() {
    setBusy('sweep');
    try {
      const unused = await findUnusedImages();
      if (unused.ids.length === 0) {
        report('No unused images — every stored image is still used somewhere.');
        return;
      }
      const size = unused.bytes > 1_000_000 ? `${(unused.bytes / 1_000_000).toFixed(1)} MB` : `${Math.ceil(unused.bytes / 1000)} KB`;
      if (!window.confirm(`Delete ${unused.ids.length} unused image${unused.ids.length === 1 ? '' : 's'} (${size})? Nothing in your notes, deleted notes or version history uses them.`)) return;
      await deleteImagesLocally(unused.ids);
      const cloud = await removeFromStorage(unused.uploadedIds);
      logEvent('images', 'Unused images removed', { local: unused.ids.length, cloud: cloud.removed, bytes: unused.bytes, error: cloud.error ?? null });
      report(`Removed ${unused.ids.length} unused image${unused.ids.length === 1 ? '' : 's'} (${size}).${cloud.error ? ` ${cloud.error}` : ''}`);
    } catch (err) {
      setMessage(null);
      setError(err instanceof Error ? err.message : 'Cleaning up failed.');
    } finally {
      setBusy(null);
    }
  }

  /** A pre-upgrade snapshot, as an ordinary backup file the importer can read. */
  async function handleDownloadSnapshot(id: string) {
    const snapshot = await getSnapshot(id);
    if (!snapshot) {
      setMessage(null);
      setError('That snapshot is no longer here.');
      return;
    }
    const backup = await backupFromTables(snapshot.tables, snapshot.fromVersion, snapshot.takenAt);
    downloadText(
      `clemnotes-before-v${snapshot.toVersion}-${timestampSlug(snapshot.takenAt)}.json`,
      serializeBackup(backup),
      'application/json'
    );
  }

  /**
   * Import always merges, keeping whichever copy of a row is newer — the same
   * rule cloud sync uses. There is a `replace` mode in the importer for a true
   * restore, but it is not wired to a button: wiping the database is not
   * something to offer one click away from "export", and merging a backup into
   * an empty database gives you the restore anyway.
   */
  async function handleImportFile(file: File) {
    setBusy('import');
    try {
      const parsed = parseBackup(await file.text());
      const result: ImportReport = await importBackup(parsed, 'merge');
      const parts = [`${result.added} added`];
      if (result.updated > 0) parts.push(`${result.updated} updated`);
      if (result.kept > 0) parts.push(`${result.kept} already newer here`);
      report(
        `Imported from ${new Date(parsed.exportedAt).toLocaleDateString()}: ${parts.join(', ')}.` +
          (isFromNewerSchema(parsed)
            ? ' That backup came from a newer version of Clemnotes — anything it added is preserved but unused until you update.'
            : '')
      );
    } catch (err) {
      setMessage(null);
      setError(err instanceof Error ? err.message : 'That file could not be imported.');
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <div className="sync backup">
      <button type="button" className="sync-toggle" onClick={() => setExpanded((v) => !v)}>
        <span className="sync-dot sync-dot-backup" />
        <span className="sync-toggle-label">Export &amp; backup</span>
        <span className="sync-caret">{expanded ? '▾' : '▸'}</span>
      </button>

      {diagnosticsOpen && <DiagnosticsPanel onClose={() => setDiagnosticsOpen(false)} />}

      {expanded && (
        <div className="sync-detail">
          <p className="backup-blurb">
            A backup is a plain JSON file holding every rem, card, review, definition and image
            {typeof noteCount === 'number' ? ` — ${noteCount} rem${noteCount === 1 ? '' : 's'} right now` : ''}.
            Keep one somewhere that isn't this browser.
          </p>

          <div className="backup-actions">
            <button
              type="button"
              className="primary-btn"
              onClick={() => void handleExportJson()}
              disabled={busy !== null}
            >
              {busy === 'json' ? 'Exporting…' : 'Back up everything (.json)'}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void handleExportMarkdown()}
              disabled={busy !== null}
            >
              {busy === 'markdown' ? 'Exporting…' : 'Export notes as Markdown'}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => fileInput.current?.click()}
              disabled={busy !== null}
            >
              {busy === 'import' ? 'Importing…' : 'Restore from a backup…'}
            </button>
          </div>

          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
            }}
          />

          <p className="backup-note">
            Restoring merges: where the same rem exists on both sides, the newer one wins, so an
            import never rolls back work you've done since.
          </p>

          <ImportSection onMessage={report} onError={(text) => { setMessage(null); setError(text); }} />

          {snapshots && snapshots.length > 0 && (
            <div className="backup-snapshots">
              <div className="backup-snapshots-title">Saved before upgrades</div>
              <ul>
                {snapshots.map((snap) => (
                  <li key={snap.id}>
                    <span>
                      {new Date(snap.takenAt).toLocaleDateString()} · v{snap.fromVersion} → v
                      {snap.toVersion} · {snap.counts.nodes ?? 0} rems
                    </span>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => void handleDownloadSnapshot(snap.id)}
                    >
                      Download
                    </button>
                  </li>
                ))}
              </ul>
              <p className="backup-note">
                A copy of everything is kept from just before each of the last three upgrades.
              </p>
            </div>
          )}

          <div className="import-section">
            <div className="backup-snapshots-title">Maintenance</div>
            <div className="backup-actions">
              <button type="button" className="ghost-btn" disabled={busy !== null} onClick={() => void handleSweepImages()}>
                {busy === 'sweep' ? 'Checking…' : 'Clean up unused images'}
              </button>
              <button type="button" className="ghost-btn" onClick={() => setDiagnosticsOpen(true)}>
                Diagnostics…
              </button>
            </div>
          </div>

          {message && <div className="backup-message">{message}</div>}
          {error && <div className="sync-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
