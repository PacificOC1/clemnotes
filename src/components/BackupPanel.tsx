import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/database';
import { backupFilename, buildBackup, serializeBackup } from '../export/backup';
import { downloadText, timestampSlug } from '../export/download';
import { importBackup, isFromNewerSchema, parseBackup, type ImportReport } from '../export/importBackup';
import { pagesToMarkdown } from '../export/markdown';
import { buildExportTrees } from '../export/tree';

type Busy = 'json' | 'markdown' | 'import' | null;

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

  const noteCount = useLiveQuery(
    async () => (await db.nodes.toArray()).filter((n) => n.deletedAt === null).length,
    []
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

      {expanded && (
        <div className="sync-detail">
          <p className="backup-blurb">
            A backup is a plain JSON file holding every rem, card, review and definition
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

          {message && <div className="backup-message">{message}</div>}
          {error && <div className="sync-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
