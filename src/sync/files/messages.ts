import { STORE_LABELS, type FileStoreKind } from './types';

/** Why a file isn't showing, in words. Shared by images and the PDF reader. */
export function missingFileMessage(what: 'image' | 'PDF', needsSignIn: FileStoreKind[]): string {
  if (needsSignIn.includes('gdrive')) {
    return `This ${what} isn’t on this device, and may be in Google Drive — connect Google Drive in the sidebar (open the sync panel) to load it.`;
  }
  if (needsSignIn.includes('onedrive')) {
    return `This ${what} isn’t on this device, and may be in OneDrive — sign in to OneDrive in the sidebar (open the sync panel) to load it.`;
  }
  if (needsSignIn.length > 0) {
    return `This ${what} isn’t on this device, and may be in ${STORE_LABELS[needsSignIn[0]!]} — sign in to sync to load it.`;
  }
  return `This ${what} isn’t on this device yet. It appears once the device it was added on has synced, and you’re signed in here.`;
}


/** 1.2 GB, 340 MB, 12 KB — decimal units, as storage plans are sold. */
export function formatBytes(bytes: number): string {
  const units: Array<[number, string]> = [
    [1e12, 'TB'],
    [1e9, 'GB'],
    [1e6, 'MB'],
  ];
  for (const [size, unit] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      // One decimal below 10 (1.5 GB), none above (340 MB); never "1.0".
      const shown = value >= 10 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '');
      return `${shown} ${unit}`;
    }
  }
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** Past this share of a quota, the meter turns amber and says so. */
export const NEARLY_FULL = 0.8;
