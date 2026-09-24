import { useRef, useState } from 'react';
import { logError, logEvent } from '../diagnostics';

type Kind = 'markdown' | 'folder' | 'anki';

interface Props {
  onMessage: (text: string) => void;
  onError: (text: string) => void;
}

/**
 * Bringing notes in from elsewhere (#52): Markdown files, a whole folder
 * (an Obsidian vault, with its images), or an Anki deck with its schedule and
 * review history. The importers are loaded only when used — the Anki one
 * brings a SQLite engine with it.
 */
export function ImportSection({ onMessage, onError }: Props) {
  const [busy, setBusy] = useState<Kind | null>(null);
  const markdownInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const ankiInput = useRef<HTMLInputElement>(null);

  async function run(kind: Kind, files: FileList | null) {
    const list = [...(files ?? [])];
    if (list.length === 0) return;
    setBusy(kind);
    try {
      if (kind === 'anki') {
        const { importApkg } = await import('../import/importAnki');
        const report = await importApkg(list[0]!);
        logEvent('import', 'Anki deck imported', { ...report });
        onMessage(
          `Imported ${report.notes} note${report.notes === 1 ? '' : 's'} (${report.cards} cards, ${report.reviews} past reviews` +
            `${report.images ? `, ${report.images} image${report.images === 1 ? '' : 's'}` : ''}) into the Anki folder, schedules included.`
        );
      } else {
        const { importMarkdownFiles } = await import('../import/importMarkdown');
        const withPaths = list.map((file) => ({ path: file.webkitRelativePath || file.name, file }));
        const folderName =
          kind === 'folder'
            ? (withPaths[0]?.path.split('/')[0] ?? 'Imported')
            : `Imported ${new Date().toLocaleDateString()}`;
        const report = await importMarkdownFiles(withPaths, folderName);
        logEvent('import', 'Markdown imported', {
          files: withPaths.length,
          pages: report.pages,
          rems: report.rems,
          images: report.images,
          missingImages: report.missingImages.length,
        });
        const extras = [
          report.images ? `${report.images} image${report.images === 1 ? '' : 's'}` : '',
          report.tags ? `${report.tags} new tag${report.tags === 1 ? '' : 's'}` : '',
        ].filter(Boolean);
        onMessage(
          `Imported ${report.pages} page${report.pages === 1 ? '' : 's'} (${report.rems} rems${extras.length ? `, ${extras.join(', ')}` : ''}) into “${report.folder}”.` +
            (report.missingImages.length
              ? ` ${report.missingImages.length} image${report.missingImages.length === 1 ? " wasn't" : "s weren't"} among the files picked.`
              : '')
        );
      }
    } catch (err) {
      logError('import', err, { kind });
      onError(err instanceof Error ? err.message : 'That import failed.');
    } finally {
      setBusy(null);
      for (const input of [markdownInput, folderInput, ankiInput]) if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="import-section">
      <div className="backup-snapshots-title">Import from elsewhere</div>
      <div className="backup-actions">
        <button type="button" className="ghost-btn" disabled={busy !== null} onClick={() => markdownInput.current?.click()}>
          {busy === 'markdown' ? 'Importing…' : 'Markdown files…'}
        </button>
        <button type="button" className="ghost-btn" disabled={busy !== null} onClick={() => folderInput.current?.click()}>
          {busy === 'folder' ? 'Importing…' : 'A folder / Obsidian vault…'}
        </button>
        <button type="button" className="ghost-btn" disabled={busy !== null} onClick={() => ankiInput.current?.click()}>
          {busy === 'anki' ? 'Importing…' : 'Anki deck (.apkg)…'}
        </button>
      </div>
      <input
        ref={markdownInput}
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        multiple
        hidden
        onChange={(e) => void run('markdown', e.target.files)}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        // A non-standard attribute every current browser supports.
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(e) => void run('folder', e.target.files)}
      />
      <input ref={ankiInput} type="file" accept=".apkg" hidden onChange={(e) => void run('anki', e.target.files)} />
      <p className="backup-note">
        Links between imported notes are kept, tags get pages, and an Anki deck keeps each card's
        schedule and review history.
      </p>
    </div>
  );
}
