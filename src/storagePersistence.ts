import { logEvent } from './diagnostics';

/**
 * Asking the browser to keep Clemnotes' storage for good.
 *
 * Everything you write lives in this site's IndexedDB. By default that is
 * "best-effort" storage, which the browser may clear on its own to free
 * space (and Safari clears after a week unused). Persistent storage is exempt
 * from that. Chrome and Edge grant it without asking for a site you use a lot,
 * have bookmarked or installed; Firefox asks you.
 *
 * It does NOT survive you (or a browser setting, or your school's policy)
 * clearing site data on purpose — "clear cookies and site data when you
 * close the browser" wipes persistent storage too.
 */
export type PersistState = 'persisted' | 'best-effort' | 'unsupported';

const LAST_STATE_KEY = 'clemnotes:storagePersisted';

export async function persistState(): Promise<PersistState> {
  try {
    if (!navigator.storage?.persisted) return 'unsupported';
    return (await navigator.storage.persisted()) ? 'persisted' : 'best-effort';
  } catch {
    return 'unsupported';
  }
}

/** Ask for persistent storage (a no-op once granted). Never throws. */
export async function requestPersistentStorage(): Promise<PersistState> {
  try {
    if (!navigator.storage?.persist) return 'unsupported';
    if (await navigator.storage.persisted()) return 'persisted';
    return (await navigator.storage.persist()) ? 'persisted' : 'best-effort';
  } catch {
    return 'unsupported';
  }
}

/** At startup: ask, and note it in diagnostics when the answer changes. */
export async function requestPersistentStorageAtStartup(): Promise<void> {
  const state = await requestPersistentStorage();
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_STATE_KEY);
    localStorage.setItem(LAST_STATE_KEY, state);
  } catch {
    // Storage blocked: nothing to compare against, log anyway.
  }
  if (last === state) return;
  if (last === null && state === 'persisted') {
    logEvent('app', 'Storage is persistent: the browser will not clear your notes on its own');
  } else if (state === 'persisted') {
    logEvent('app', 'Storage became persistent');
  } else if (last === null) {
    // Also what a browser that wipes everything on exit looks like on every
    // load: the remembered state is gone with the notes.
    logEvent('app', `Storage is ${state}: the browser may clear it`, undefined, 'warn');
  } else {
    logEvent('app', `Storage is no longer persistent (${state})`, undefined, 'warn');
  }
}
