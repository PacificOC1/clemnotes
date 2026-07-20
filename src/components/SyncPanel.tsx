import { useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase, isSyncConfigured } from '../sync/supabaseClient';
import { syncWithCloud } from '../sync/syncEngine';

type SyncStatus = 'idle' | 'syncing' | 'error';

export function SyncPanel() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [authError, setAuthError] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  async function runSync(userId: string) {
    setStatus('syncing');
    try {
      const result = await syncWithCloud(userId);
      setLastSyncedAt(Date.now());
      setStatusMessage(
        result.pushed || result.pulled ? `Synced (↑${result.pushed} ↓${result.pulled})` : 'Up to date'
      );
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setStatusMessage(err instanceof Error ? err.message : 'Sync failed');
    }
  }

  // Auto-sync on sign-in, then periodically, and whenever the tab regains focus.
  useEffect(() => {
    if (!user) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    runSync(user.id);
    intervalRef.current = setInterval(() => runSync(user.id), 20000);
    function handleFocus() {
      if (user) runSync(user.id);
    }
    window.addEventListener('focus', handleFocus);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      window.removeEventListener('focus', handleFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  if (!isSyncConfigured || !supabase) {
    return <div className="sync-panel sync-panel-disabled">Cloud sync not configured</div>;
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
      if (error) {
        setAuthError(error.message);
      } else if (mode === 'signUp') {
        setAuthError('Check your email to confirm your account, then sign in.');
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Something went wrong — please try again.');
    }
  }

  async function handleSignOut() {
    await supabase!.auth.signOut();
    setStatusMessage(null);
    setLastSyncedAt(null);
  }

  if (!user) {
    return (
      <form className="sync-panel" onSubmit={handleSubmit}>
        <div className="sync-panel-tabs">
          <button
            type="button"
            className={mode === 'signIn' ? 'active' : ''}
            onClick={() => setMode('signIn')}
          >
            Sign In
          </button>
          <button
            type="button"
            className={mode === 'signUp' ? 'active' : ''}
            onClick={() => setMode('signUp')}
          >
            Sign Up
          </button>
        </div>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
        />
        <button type="submit" className="sync-submit-btn">
          {mode === 'signIn' ? 'Sign In' : 'Sign Up'}
        </button>
        {authError && <div className="sync-error">{authError}</div>}
      </form>
    );
  }

  return (
    <div className="sync-panel">
      <div className="sync-user-row">
        <span className="sync-user-email">{user.email}</span>
        <button className="sync-signout-btn" onClick={handleSignOut}>
          Sign out
        </button>
      </div>
      <button className="sync-now-btn" onClick={() => runSync(user.id)} disabled={status === 'syncing'}>
        {status === 'syncing' ? 'Syncing…' : 'Sync now'}
      </button>
      {statusMessage && (
        <div className={`sync-status ${status === 'error' ? 'sync-status-error' : ''}`}>{statusMessage}</div>
      )}
      {lastSyncedAt && status !== 'syncing' && (
        <div className="sync-timestamp">Last synced {new Date(lastSyncedAt).toLocaleTimeString()}</div>
      )}
    </div>
  );
}
