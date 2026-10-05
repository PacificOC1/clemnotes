import { useSyncExternalStore } from 'react';
import { checkOneDriveConfig } from './oneDriveConfig';
import { checkGoogleDriveConfig } from './googleDriveConfig';
import type { FileStoreKind } from './types';

/**
 * Which store this device *puts* new files in, and a change signal for
 * everything that cares (the sidebar, and images that couldn't be fetched
 * before a sign-in).
 *
 * Deliberately free of MSAL and supabase-js imports: this module is on the
 * startup path, and both of those are lazy chunks.
 */

export const oneDriveConfig = checkOneDriveConfig(import.meta.env.VITE_ONEDRIVE_CLIENT_ID as string | undefined);
export const googleDriveConfig = checkGoogleDriveConfig(import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined);

const configuredForTests: Partial<Record<FileStoreKind, boolean>> = {};

/** Does this build have that store set up? (Supabase: see `isStoreAvailable` in imageSync.) */
export function isStoreConfigured(kind: FileStoreKind): boolean {
  const forced = configuredForTests[kind];
  if (forced !== undefined) return forced;
  if (kind === 'onedrive') return oneDriveConfig.ok;
  if (kind === 'gdrive') return googleDriveConfig.ok;
  return true;
}

export function isOneDriveConfigured(): boolean {
  return isStoreConfigured('onedrive');
}

export function isGoogleDriveConfigured(): boolean {
  return isStoreConfigured('gdrive');
}

/** Tests: pretend the build has (or hasn't) a store set up; `null` undoes it. */
export function setStoreConfiguredForTests(kind: FileStoreKind, value: boolean | null): void {
  if (value === null) delete configuredForTests[kind];
  else configuredForTests[kind] = value;
}

export function setOneDriveConfiguredForTests(value: boolean | null): void {
  setStoreConfiguredForTests('onedrive', value);
}

const KEY = 'clemnotes:fileStore';

/** Every store, in the order they're offered and preferred as a default. */
export const ALL_STORES: FileStoreKind[] = ['gdrive', 'onedrive', 'supabase'];

/**
 * A build with a drive set up defaults every device to it, so a phone you
 * sign in on months from now does the right thing without a setting to
 * remember. The choice below overrides that per device.
 */
export function defaultFileStore(): FileStoreKind {
  return ALL_STORES.find(isStoreConfigured) ?? 'supabase';
}

function readPreference(): FileStoreKind | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw === 'supabase' || raw === 'onedrive' || raw === 'gdrive' ? raw : null;
  } catch {
    return null;
  }
}

/** The store new uploads go to on this device. */
export function activeFileStore(): FileStoreKind {
  const chosen = readPreference();
  if (chosen && isStoreConfigured(chosen)) return chosen;
  return defaultFileStore();
}

/** The others this build has, for reads that miss and for moving files over. */
export function otherFileStores(kind: FileStoreKind): FileStoreKind[] {
  return ALL_STORES.filter((other) => other !== kind && isStoreConfigured(other));
}

export function setActiveFileStore(kind: FileStoreKind): void {
  try {
    globalThis.localStorage?.setItem(KEY, kind);
  } catch {
    // Private mode: the choice lasts for this tab only, via the default.
  }
  notifyFileStoreChanged();
}

let version = 0;
const listeners = new Set<() => void>();

/** Something about file storage changed: the choice, or a sign-in/out. */
export function notifyFileStoreChanged(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeFileStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A number that goes up on every change — a dependency for effects that should retry. */
export function useFileStoreVersion(): number {
  return useSyncExternalStore(subscribeFileStore, () => version, () => version);
}
