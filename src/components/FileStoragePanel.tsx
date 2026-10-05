import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/database';
import {
  activeFileStore,
  ALL_STORES,
  googleDriveConfig,
  isStoreConfigured,
  otherFileStores,
  setActiveFileStore,
  useFileStoreVersion,
} from '../sync/files/fileStoreState';
import { getOneDriveAccount, signInToOneDrive, signOutOfOneDrive, takeSignInError } from '../sync/files/oneDriveAuth';
import {
  disconnectGoogleDrive,
  getGoogleDriveAccount,
  signInToGoogleDrive,
  takeGoogleSignInError,
} from '../sync/files/googleDriveAuth';
import { fileStore, isStoreAvailable } from '../sync/imageSync';
import { moveFiles, type MoveProgress } from '../sync/files/moveFiles';
import { formatBytes, NEARLY_FULL } from '../sync/files/messages';
import { SUPABASE_FREE_STORAGE_BYTES } from '../sync/files/supabaseStore';
import { isNeedsSignIn, STORE_LABELS, type FileStoreKind, type StoreUsage } from '../sync/files/types';

type Usage = { state: 'loading' } | { state: 'ready'; usage: StoreUsage } | { state: 'signed-out' } | { state: 'error'; message: string };

/** Who a drive is connected as: `undefined` while checking, `null` when not connected. */
interface Account {
  name: string;
  note: string | null;
}

type DriveKind = Exclude<FileStoreKind, 'supabase'>;

const DRIVES: Record<DriveKind, {
  account: () => Promise<Account | null>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  takeError: () => string | null;
  signInLabel: string;
  signOutLabel: string;
}> = {
  gdrive: {
    account: async () => {
      const found = await getGoogleDriveAccount();
      return found ? { name: found.email ?? 'Google account', note: 'all your devices' } : null;
    },
    signIn: signInToGoogleDrive,
    signOut: disconnectGoogleDrive,
    takeError: takeGoogleSignInError,
    signInLabel: 'Connect Google Drive',
    signOutLabel: 'Disconnect',
  },
  onedrive: {
    account: async () => {
      const found = await getOneDriveAccount();
      return found ? { name: found.username, note: found.organisational ? 'work or school' : 'personal' } : null;
    },
    signIn: signInToOneDrive,
    signOut: signOutOfOneDrive,
    takeError: takeSignInError,
    signInLabel: 'Sign in to OneDrive',
    signOutLabel: 'Sign out',
  },
};

const SHORT_LABELS: Record<FileStoreKind, string> = { supabase: 'Supabase', onedrive: 'OneDrive', gdrive: 'Google Drive' };

/**
 * Where images and PDFs are kept (#46/#53 bytes, not rows): the choice of
 * store for this device, connecting a drive, a meter for how full it is, and
 * moving files over from the other stores.
 *
 * Shown inside the sync panel once signed in — file storage rides on sync.
 */
export function FileStoragePanel({ onChanged }: { onChanged: () => void }) {
  const version = useFileStoreVersion();
  const kind = activeFileStore();
  const others = otherFileStores(kind).filter(isStoreAvailable);
  const choices = ALL_STORES.filter((option) => isStoreConfigured(option) && isStoreAvailable(option)).reverse();
  const [accounts, setAccounts] = useState<Partial<Record<DriveKind, Account | null>>>({});
  const [signInError, setSignInError] = useState<string | null>(null);
  const [usage, setUsage] = useState<Partial<Record<FileStoreKind, Usage>>>({});
  const [moving, setMoving] = useState<MoveProgress | null>(null);
  const [moveMessage, setMoveMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stopRef = useRef(false);
  const pending = useLiveQuery(() => db.images.where('uploadedAt').equals(0).count(), []) ?? 0;

  // Who each configured drive is connected as.
  useEffect(() => {
    let cancelled = false;
    for (const drive of Object.keys(DRIVES) as DriveKind[]) {
      if (!isStoreConfigured(drive)) continue;
      const helper = DRIVES[drive];
      const error = helper.takeError();
      if (error) setSignInError(error);
      void helper
        .account()
        .then((found) => {
          if (!cancelled) setAccounts((prev) => ({ ...prev, [drive]: found }));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setAccounts((prev) => ({ ...prev, [drive]: null }));
          if (drive === kind) setSignInError(err instanceof Error ? err.message : String(err));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [version, kind]);

  const measure = useCallback(async (which: FileStoreKind) => {
    if (!isStoreAvailable(which)) return;
    setUsage((prev) => ({ ...prev, [which]: { state: 'loading' } }));
    try {
      const found = await fileStore(which).usage();
      setUsage((prev) => ({ ...prev, [which]: { state: 'ready', usage: found } }));
    } catch (err) {
      setUsage((prev) => ({
        ...prev,
        [which]: isNeedsSignIn(err)
          ? { state: 'signed-out' }
          : { state: 'error', message: err instanceof Error ? err.message : String(err) },
      }));
    }
  }, []);

  const connected = (which: FileStoreKind) => which === 'supabase' || Boolean(accounts[which]);
  const settled = (which: FileStoreKind) => which === 'supabase' || accounts[which] !== undefined;
  const othersKey = others.map((o) => `${o}:${settled(o)}:${connected(o)}`).join(',');

  // Measure this store for the meter, and the others to know what's left to move.
  useEffect(() => {
    if (settled(kind) && connected(kind)) void measure(kind);
    for (const other of others) if (settled(other) && connected(other)) void measure(other);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, othersKey, accounts[kind as DriveKind], measure]);

  function choose(next: FileStoreKind) {
    if (next === kind) return;
    setActiveFileStore(next);
    setMoveMessage(null);
    setSignInError(null);
    onChanged();
  }

  async function handleSignIn(drive: DriveKind) {
    setBusy(true);
    setSignInError(null);
    try {
      await DRIVES[drive].signIn();
      // The page leaves for Microsoft or Google here.
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function handleSignOut(drive: DriveKind) {
    if (drive === 'gdrive' && !window.confirm('Disconnect Google Drive from Clemnotes on all your devices? Files already in Drive stay there.')) return;
    setBusy(true);
    try {
      await DRIVES[drive].signOut();
      setAccounts((prev) => ({ ...prev, [drive]: null }));
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleMove(from: FileStoreKind, to: FileStoreKind) {
    stopRef.current = false;
    setMoveMessage(null);
    setMoving({ done: 0, total: 0, bytes: 0 });
    try {
      const result = await moveFiles(fileStore(from), fileStore(to), setMoving, () => stopRef.current);
      const moved = `Moved ${result.done} file${result.done === 1 ? '' : 's'} (${formatBytes(result.bytes)}) to ${STORE_LABELS[to]}.`;
      if (result.error) setMoveMessage(`${moved} Stopped: ${result.error} Press again to carry on.`);
      else if (stopRef.current && result.done < result.total) setMoveMessage(`${moved} Stopped — press again to carry on.`);
      else if (result.skipped) setMoveMessage(`${moved} ${result.skipped} couldn’t be read and were left where they were.`);
      else setMoveMessage(moved);
    } catch (err) {
      setMoveMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setMoving(null);
      void measure(from);
      void measure(to);
    }
  }

  const here = usage[kind];
  const drive = kind === 'supabase' ? null : kind;
  const account = drive ? accounts[drive] : null;
  const needsSignIn = drive !== null && (account === null || here?.state === 'signed-out');
  const leftovers = others
    .map((other) => ({ other, found: usage[other] }))
    .filter((entry): entry is { other: FileStoreKind; found: { state: 'ready'; usage: StoreUsage } } =>
      entry.found?.state === 'ready' && entry.found.usage.files > 0
    );

  return (
    <div className="files-panel">
      <div className="files-heading">Images &amp; PDFs</div>

      {choices.length > 1 && (
        <div className="files-choice" role="radiogroup" aria-label="Where images and PDFs are kept">
          {choices.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={kind === option}
              className={kind === option ? 'active' : ''}
              disabled={moving !== null}
              onClick={() => choose(option)}
            >
              {option === 'gdrive' && choices.length > 2 ? 'Google' : SHORT_LABELS[option]}
            </button>
          ))}
        </div>
      )}

      {!isStoreConfigured('gdrive') && (
        <div className="sync-note">
          {googleDriveConfig.ok || googleDriveConfig.absent
            ? 'Kept in Supabase Storage. For more room, set up Google Drive — see “Google Drive for images and PDFs” in the README.'
            : googleDriveConfig.problem}
        </div>
      )}

      {drive && (
        <div className="files-account">
          {account === undefined ? (
            <span className="sync-note">Checking {STORE_LABELS[drive]}…</span>
          ) : account ? (
            <>
              <span className="files-account-name" title={account.name}>
                {account.name}
                {account.note && <span className="files-account-kind">{account.note}</span>}
              </span>
              <button type="button" className="link-btn" onClick={() => void handleSignOut(drive)} disabled={busy || moving !== null}>
                {DRIVES[drive].signOutLabel}
              </button>
              {here?.state === 'signed-out' && (
                // Connected once, but the connection has run out.
                <button type="button" className="primary-btn files-signin files-signin-again" onClick={() => void handleSignIn(drive)} disabled={busy}>
                  {busy ? 'Opening sign-in…' : 'Connect again'}
                </button>
              )}
            </>
          ) : (
            <button type="button" className="primary-btn files-signin" onClick={() => void handleSignIn(drive)} disabled={busy}>
              {busy ? 'Opening sign-in…' : DRIVES[drive].signInLabel}
            </button>
          )}
        </div>
      )}
      {signInError && <div className="sync-error">{signInError}</div>}

      {pending > 0 && (
        <div className="sync-note">
          {pending} file{pending === 1 ? '' : 's'} waiting to upload
          {needsSignIn ? ' — they stay on this device until you connect.' : '.'}
        </div>
      )}

      <UsageMeter kind={kind} usage={here} />

      {!moving &&
        leftovers.map(({ other, found }) => (
          <div className="files-move" key={other}>
            {STORE_LABELS[other]} still holds {found.usage.files} file{found.usage.files === 1 ? '' : 's'} (
            {formatBytes(found.usage.filesBytes)}).
            <button
              type="button"
              className="ghost-btn"
              disabled={needsSignIn || busy}
              onClick={() => void handleMove(other, kind)}
            >
              Move them to {STORE_LABELS[kind]}
            </button>
          </div>
        ))}
      {moving && (
        <div className="files-move" aria-live="polite">
          Moving {moving.done} of {moving.total || '…'} ({formatBytes(moving.bytes)})
          <progress max={moving.total || 1} value={moving.done} />
          <button type="button" className="link-btn" onClick={() => (stopRef.current = true)}>
            Stop
          </button>
        </div>
      )}
      {moveMessage && <div className="sync-note">{moveMessage}</div>}
    </div>
  );
}

function UsageMeter({ kind, usage }: { kind: FileStoreKind; usage: Usage | undefined }) {
  if (!usage || usage.state === 'signed-out') return null;
  if (usage.state === 'loading') return <div className="sync-note">Measuring…</div>;
  if (usage.state === 'error') return <div className="sync-error">Couldn’t measure {STORE_LABELS[kind]}: {usage.message}</div>;

  const { files, filesBytes, quota } = usage.usage;
  // The drives tell us the account's own numbers. Supabase can't, so the bar
  // is against the free plan's 1 GB, and says so.
  const used = quota ? quota.used : filesBytes;
  const total = quota ? quota.total : kind === 'supabase' ? SUPABASE_FREE_STORAGE_BYTES : null;
  const share = total ? Math.min(1, used / total) : null;
  const nearlyFull = share !== null && share >= NEARLY_FULL;

  return (
    <div className={`files-meter ${nearlyFull ? 'is-nearly-full' : ''}`}>
      <div className="files-meter-line">
        Clemnotes: {formatBytes(filesBytes)} in {files} file{files === 1 ? '' : 's'}
      </div>
      {share !== null && total !== null && (
        <>
          <div
            className="files-meter-bar"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={used}
            aria-label={`${STORE_LABELS[kind]} space used`}
          >
            <span style={{ width: `${Math.max(share * 100, 1)}%` }} />
          </div>
          <div className="files-meter-line">
            {quota
              ? `${formatBytes(used)} of ${formatBytes(total)} used in this ${STORE_LABELS[kind]}`
              : `${Math.round(share * 100)}% of the ${formatBytes(total)} on Supabase’s free plan`}
          </div>
        </>
      )}
      {nearlyFull && (
        <div className="files-meter-warning">
          {kind === 'supabase'
            ? 'Nearly full. Clean up unused images (Export & backup → Maintenance), or keep files in Google Drive instead.'
            : `This ${STORE_LABELS[kind]} is nearly full.`}
        </div>
      )}
    </div>
  );
}
