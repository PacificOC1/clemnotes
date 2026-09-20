import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase, isSyncConfigured } from '../sync/supabaseClient';
import { syncWithCloud } from '../sync/syncEngine';
import { clearCursors } from '../sync/cursors';

type SyncStatus = 'idle' | 'syncing' | 'error';

const SYNC_INTERVAL_MS = 20000;

/** Which SQL file creates each table, so the warning points at the right one. */
const MIGRATION_FOR_TABLE: Record<string, string> = {
  dictionary: 'migration-002-sync-all.sql',
  folders: 'migration-002-sync-all.sql',
  cards: 'migration-002-sync-all.sql',
  reviews: 'migration-003-reviews.sql',
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
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [missingTables, setMissingTables] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const runSync = useCallback(async (userId: string) => {
    setStatus('syncing');
    try {
      const result = await syncWithCloud(userId);
      setLastSyncedAt(Date.now());
      setMissingTables(result.failed);
      setStatusMessage(
        result.pushed || result.pulled ? `Synced ↑${result.pushed} ↓${result.pulled}` : 'Up to date'
      );
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setStatusMessage(err instanceof Error ? err.message : 'Sync failed');
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

  if (!isSyncConfigured || !supabase) {
    return <div className="sync sync-off">Cloud sync not configured</div>;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    if (!supabase) return;
    try {
      const { error } =
        mode === 'signIn'
          ? await supabase.auth.signInWithPassword({ email, password })
          : await supabase.auth.signUp({ email, password });
      if (error) setAuthError(error.message);
      else if (mode === 'signUp') setAuthError('Check your email to confirm your account, then sign in.');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Something went wrong — please try again.');
    }
  }

  async function handleSignOut() {
    await supabase!.auth.signOut();
    setStatusMessage(null);
    setLastSyncedAt(null);
    setMissingTables([]);
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
        </div>
      )}
    </div>
  );
}
