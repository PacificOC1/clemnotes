import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { getSupabase, isSyncConfigured, syncConfigProblem } from '../sync/supabaseClient';
import { describeNetworkError } from '../sync/syncConfig';
import { logError } from '../diagnostics';
import { syncWithCloud } from '../sync/syncEngine';
import { clearCursors } from '../sync/cursors';
import { useLiveQuery } from 'dexie-react-hooks';
import { getUnseenConflicts } from '../db/versionRepository';
import { VersionHistory } from './VersionHistory';
import type { ImageSyncResult } from '../sync/imageSync';

// Only drawn with the panel open; the drives' sign-in code with it.
const FileStoragePanel = lazy(() => import('./FileStoragePanel').then((m) => ({ default: m.FileStoragePanel })));

/**
 * The file-storage section is a separate chunk. If it can't load — offline
 * with a stale cache, a deploy that replaced it, a missing dependency in
 * development — say so here instead of taking the whole app down with it.
 */
class FilePanelBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error): void {
    logError('files', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="sync-error">
        Image &amp; PDF storage settings couldn’t load ({this.state.error.message.split('\n')[0]}). Syncing still
        works; reload the page to try again.
      </div>
    );
  }
}

function signInToDrive(store: 'onedrive' | 'gdrive') {
  if (store === 'gdrive') void import('../sync/files/googleDriveAuth').then((m) => m.signInToGoogleDrive());
  else void import('../sync/files/oneDriveAuth').then((m) => m.signInToOneDrive());
}

const DRIVE_NAMES = { onedrive: 'OneDrive', gdrive: 'Google Drive' } as const;

type SyncStatus = 'idle' | 'syncing' | 'error';

const SYNC_INTERVAL_MS = 20000;

/** Which SQL file creates each table, so the warning points at the right one. */
const MIGRATION_FOR_TABLE: Record<string, string> = {
  dictionary: 'migration-002-sync-all.sql',
  folders: 'migration-002-sync-all.sql',
  cards: 'migration-002-sync-all.sql',
  reviews: 'migration-003-reviews.sql',
  images: 'migration-005-images.sql',
};

function migrationsFor(tables: string[]): string[] {
  const files = tables.map((t) => MIGRATION_FOR_TABLE[t]).filter((f): f is string => Boolean(f));
  return [...new Set(files)].sort();
}

const TABLE_LABELS: Record<string, string> = {
  dictionary: 'definitions',
  folders: 'folders',
  cards: 'flashcards',
  reviews: 'review history',
  images: 'images',
};

function describeMissing(tables: string[]): string {
  const labels = tables.map((t) => TABLE_LABELS[t] ?? t);
  if (labels.length <= 1) return labels[0] ?? 'them';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

export function SyncPanel() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [authError, setAuthError] = useState<string | null>(null);
  /** Not an error: what happened after a sign-up that needs you to do something. */
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [missingTables, setMissingTables] = useState<string[]>([]);
  /** How the last sync's file uploads went (a drive sign-in, connection). */
  const [files, setFiles] = useState<ImageSyncResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const conflicts = useLiveQuery(() => getUnseenConflicts(), []) ?? [];
  const [conflictOpen, setConflictOpen] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isSyncConfigured) return;
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    void getSupabase().then((supabase) => {
      if (!supabase || cancelled) return;
      void supabase.auth.getSession().then(({ data }) => {
        if (!cancelled) setUser(data.session?.user ?? null);
      });
      const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
        setUser(session?.user ?? null);
      });
      unsubscribe = () => listener.subscription.unsubscribe();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const runSync = useCallback(async (userId: string) => {
    setStatus('syncing');
    try {
      const result = await syncWithCloud(userId);
      setLastSyncedAt(Date.now());
      setMissingTables(result.failed);
      setFiles(result.files ?? null);
      setStatusMessage(
        result.pushed || result.pulled ? `Synced ↑${result.pushed} ↓${result.pulled}` : 'Up to date'
      );
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setStatusMessage(describeNetworkError(err));
    }
  }, []);

  // Auto-sync on sign-in, then periodically, and whenever the tab regains focus.
  useEffect(() => {
    if (!user) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    const userId = user.id;
    void runSync(userId);
    intervalRef.current = setInterval(() => void runSync(userId), SYNC_INTERVAL_MS);
    const handleFocus = () => void runSync(userId);
    window.addEventListener('focus', handleFocus);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      window.removeEventListener('focus', handleFocus);
    };
  }, [user?.id, runSync]);

  if (!isSyncConfigured) {
    // "Not configured" is the normal local-only state; anything else is a
    // configuration that was *attempted* and would only fail at sign-in.
    const attempted = syncConfigProblem && syncConfigProblem !== 'Cloud sync not configured';
    return (
      <div className={`sync sync-off ${attempted ? 'sync-misconfigured' : ''}`}>
        {attempted ? (
          <>
            <strong>Cloud sync is off.</strong> {syncConfigProblem}
          </>
        ) : (
          'Cloud sync not configured'
        )}
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthNotice(null);
    try {
      const supabase = await getSupabase();
      if (!supabase) return;
      if (mode === 'signIn') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) setAuthError(describeNetworkError(error));
        return;
      }
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) {
        setAuthError(describeNetworkError(error));
      } else if (data.session) {
        // Email confirmation is off (as the README suggests for personal use):
        // Supabase has already signed you in, and `onAuthStateChange` will
        // swap this form out on its own. There is no email coming.
      } else {
        setAuthNotice('Check your email to confirm your account, then sign in.');
        setMode('signIn');
      }
    } catch (err) {
      setAuthError(describeNetworkError(err));
    }
  }

  async function handleSignOut() {
    await (await getSupabase())?.auth.signOut();
    setStatusMessage(null);
    setLastSyncedAt(null);
    setMissingTables([]);
    setFiles(null);
  }

  /**
   * Forget where each table got to, so the next sync re-reads everything and
   * reconciles it properly. The escape hatch for the one thing incremental
   * sync can get wrong — a device whose clock was far enough out that a row
   * slipped past the watermark — and harmless to press at any time.
   */
  async function handleFullResync(userId: string) {
    clearCursors(userId);
    await runSync(userId);
  }

  if (!user) {
    return (
      <div className="sync">
        <button type="button" className="sync-toggle" onClick={() => setExpanded((v) => !v)}>
          <span className="sync-dot sync-dot-off" />
          <span className="sync-toggle-label">Sign in to sync</span>
          <span className="sync-caret">{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded && (
          <form className="sync-form" onSubmit={handleSubmit}>
            <div className="sync-tabs">
              <button type="button" className={mode === 'signIn' ? 'active' : ''} onClick={() => setMode('signIn')}>Sign in</button>
              <button type="button" className={mode === 'signUp' ? 'active' : ''} onClick={() => setMode('signUp')}>Sign up</button>
            </div>
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
            <button type="submit" className="primary-btn sync-submit">{mode === 'signIn' ? 'Sign in' : 'Sign up'}</button>
            {authError && <div className="sync-error">{authError}</div>}
            {authNotice && <div className="sync-notice">{authNotice}</div>}
          </form>
        )}
      </div>
    );
  }

  return (
    <div className="sync">
      <button type="button" className="sync-toggle" onClick={() => setExpanded((v) => !v)}>
        <span className={`sync-dot ${status === 'error' ? 'sync-dot-error' : status === 'syncing' ? 'sync-dot-busy' : 'sync-dot-ok'}`} />
        <span className="sync-toggle-label">
          {status === 'syncing' ? 'Syncing…' : statusMessage ?? 'Synced'}
        </span>
        <span className="sync-caret">{expanded ? '▾' : '▸'}</span>
      </button>

      {conflicts.length > 0 && (
        <div className="sync-conflicts">
          <strong>
            {conflicts.length} edit{conflicts.length === 1 ? '' : 's'} kept from a sync conflict
          </strong>{' '}
          — the same rem was changed on two devices. The newer text won; the other is in its
          history.
          <ul>
            {conflicts.slice(0, 5).map((version) => (
              <li key={version.id}>
                <button type="button" className="link-btn" onClick={() => setConflictOpen(version.nodeId)}>
                  {version.plainText.trim().slice(0, 48) || 'Untitled'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {conflictOpen && <VersionHistory nodeId={conflictOpen} onClose={() => setConflictOpen(null)} />}

      {missingTables.length > 0 && (
        <div className="sync-warning">
          <strong>{missingTables.join(', ')}</strong> {missingTables.length === 1 ? "isn't" : "aren't"} set up
          in Supabase yet — run{' '}
          {migrationsFor(missingTables).map((file, i, all) => (
            <span key={file}>
              <code>supabase/{file}</code>
              {i < all.length - 1 ? ' and ' : ''}
            </span>
          ))}{' '}
          to sync {describeMissing(missingTables)} too. Everything else is syncing fine in the
          meantime.
        </div>
      )}

      {files && files.store !== 'supabase' && files.error && (
        <div className="sync-warning">
          {files.needsSignIn ? (
            <>
              <strong>
                {files.pending} file{files.pending === 1 ? '' : 's'} waiting for {DRIVE_NAMES[files.store]}.
              </strong>{' '}
              {files.error}{' '}
              <button type="button" className="link-btn" onClick={() => signInToDrive(files.store as 'onedrive' | 'gdrive')}>
                {files.store === 'gdrive' ? 'Connect Google Drive' : 'Sign in to OneDrive'}
              </button>
            </>
          ) : (
            <>
              <strong>Files aren’t reaching {DRIVE_NAMES[files.store]}:</strong> {files.error} They stay on this device
              and upload on a later sync.
            </>
          )}
        </div>
      )}

      {expanded && (
        <div className="sync-detail">
          <div className="sync-email">{user.email}</div>
          <div className="sync-actions">
            <button type="button" className="ghost-btn" onClick={() => void runSync(user.id)} disabled={status === 'syncing'}>
              {status === 'syncing' ? 'Syncing…' : 'Sync now'}
            </button>
            <button type="button" className="ghost-btn" onClick={handleSignOut}>Sign out</button>
          </div>
          <button
            type="button"
            className="sync-resync"
            onClick={() => void handleFullResync(user.id)}
            disabled={status === 'syncing'}
          >
            Re-check everything
          </button>
          <div className="sync-note">
            Normally only what changed since the last sync is exchanged, with a full check once
            a day.
          </div>
          {lastSyncedAt && status !== 'syncing' && (
            <div className="sync-time">Last synced {new Date(lastSyncedAt).toLocaleTimeString()}</div>
          )}
          <FilePanelBoundary>
            <Suspense fallback={null}>
              <FileStoragePanel onChanged={() => void runSync(user.id)} />
            </Suspense>
          </FilePanelBoundary>
        </div>
      )}
    </div>
  );
}
