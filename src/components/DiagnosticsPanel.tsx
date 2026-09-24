import { useEffect, useState } from 'react';
import { clearEvents, formatDiagnostics, getEvents, onEvents, type DiagnosticEvent } from '../diagnostics';

/** The diagnostics log, newest first, with Copy (#62). */
export function DiagnosticsPanel({ onClose }: { onClose: () => void }) {
  const [events, setEvents] = useState<DiagnosticEvent[]>(getEvents);
  const [copied, setCopied] = useState(false);

  useEffect(() => onEvents(() => setEvents(getEvents())), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(formatDiagnostics());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="history-backdrop" onClick={onClose} role="presentation">
      <div className="history diagnostics" role="dialog" aria-modal="true" aria-label="Diagnostics" onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h2>Diagnostics</h2>
            <p>What the app did in the background — syncs, upgrades, imports and errors. No note text is recorded.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="diagnostics-actions">
          <button type="button" className="primary-btn" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy diagnostics'}
          </button>
          <button type="button" className="ghost-btn" onClick={clearEvents} disabled={events.length === 0}>
            Clear
          </button>
          <span className="history-note">{events.length} event{events.length === 1 ? '' : 's'}, newest first</span>
        </div>
        {events.length === 0 ? (
          <p className="history-empty">Nothing recorded yet.</p>
        ) : (
          <ol className="diagnostics-list">
            {[...events].reverse().map((event, i) => (
              <li key={`${event.at}-${i}`} className={`diag-${event.level}`}>
                <span className="diag-time">{new Date(event.at).toLocaleString()}</span>
                <span className="diag-area">{event.area}</span>
                <span className="diag-message">
                  {event.message}
                  {event.detail && (
                    <span className="diag-detail">
                      {Object.entries(event.detail)
                        .filter(([, v]) => v !== null && v !== '')
                        .map(([k, v]) => `${k} ${v}`)
                        .join(' · ')}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
