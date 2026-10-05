import { withSniffedType } from './sniff';
import { FileStoreError, type FileStore, type RemoteFile, type StoreUsage } from './types';

/**
 * Files in Google Drive's hidden app-data folder, through the Drive v3 API.
 *
 * `drive.appdata` reaches only this folder: it doesn't show up in Drive, and
 * Clemnotes can't see anything else there. Drive identifies files by its own
 * ids and happily keeps two with the same name, so each file is *named* by our
 * id and looked up by name; an upload of an id that's already there is
 * skipped (ids are unique, so it's the same bytes).
 *
 * `getToken(force)` and `fetchImpl` are passed in so tests can use a fake Drive.
 */

export const DRIVE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
/** Drive's multipart upload takes up to 5 MB; bigger files use a resumable upload. */
export const MULTIPART_MAX = 5 * 1024 * 1024;

type Fetch = typeof fetch;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A value inside a Drive query string. */
function quoted(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export interface GoogleDriveStoreOptions {
  getToken: (force?: boolean) => Promise<string>;
  fetchImpl?: Fetch;
  wait?: (ms: number) => Promise<void>;
}

export function createGoogleDriveStore({ getToken, fetchImpl, wait = sleep }: GoogleDriveStoreOptions): FileStore {
  const doFetch: Fetch = (input, init) => (fetchImpl ?? fetch)(input, init);

  /** A Drive call with the token; one retry with a fresh token, patience for rate limits. */
  async function drive(url: string, init: RequestInit = {}): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const token = await getToken(refreshed);
      let response: Response;
      try {
        response = await doFetch(url, {
          ...init,
          headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
        });
      } catch {
        throw new FileStoreError('failed', "Can't reach Google Drive — you may be offline.");
      }
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      if (response.status === 401) {
        throw new FileStoreError('needs-sign-in', 'Google Drive turned the connection down — connect it again.');
      }
      if ((response.status === 429 || response.status >= 500 || (await isRateLimit(response))) && attempt < 3) {
        await wait(Math.min(2000 * 2 ** attempt, 20_000));
        continue;
      }
      return response;
    }
  }

  async function isRateLimit(response: Response): Promise<boolean> {
    if (response.status !== 403) return false;
    const reason = await errorReason(response.clone());
    return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
  }

  async function errorReason(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { error?: { errors?: Array<{ reason?: string }>; message?: string } };
      return body.error?.errors?.[0]?.reason ?? '';
    } catch {
      return '';
    }
  }

  async function failure(response: Response, what: string): Promise<FileStoreError> {
    let reason = '';
    let message = '';
    try {
      const body = (await response.json()) as { error?: { errors?: Array<{ reason?: string }>; message?: string } };
      reason = body.error?.errors?.[0]?.reason ?? '';
      message = body.error?.message ?? '';
    } catch {
      // Not JSON.
    }
    if (reason === 'storageQuotaExceeded') return new FileStoreError('failed', 'Your Google Drive is full.');
    if (reason === 'accessNotConfigured' || /has not been used in project|is disabled/i.test(message)) {
      return new FileStoreError(
        'failed',
        'The Google Drive API isn’t switched on in your Google Cloud project — enable it under APIs & Services.'
      );
    }
    if (reason === 'insufficientPermissions' || response.status === 403) {
      return new FileStoreError('needs-sign-in', 'Google Drive access wasn’t fully granted — connect it again.');
    }
    return new FileStoreError('failed', `Google Drive couldn't ${what} (${response.status}${message ? `: ${message}` : ''}).`);
  }

  /** Drive's own id for the file named `id`, or null. */
  async function find(id: string): Promise<string | null> {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name = ${quoted(id)} and trashed = false`,
      fields: 'files(id)',
      pageSize: '10',
    });
    const response = await drive(`${DRIVE}/files?${params}`);
    if (!response.ok) throw await failure(response, 'look for a file');
    const body = (await response.json()) as { files?: Array<{ id: string }> };
    return body.files?.[0]?.id ?? null;
  }

  async function uploadResumable(id: string, data: ArrayBuffer, mime: string): Promise<void> {
    const start = await drive(`${DRIVE_UPLOAD}/files?uploadType=resumable`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(data.byteLength),
      },
      body: JSON.stringify({ name: id, parents: ['appDataFolder'], mimeType: mime }),
    });
    if (!start.ok) throw await failure(start, 'start an upload');
    const session = start.headers.get('Location');
    if (!session) throw new FileStoreError('failed', 'Google Drive didn’t return an upload address.');
    const response = await drive(session, { method: 'PUT', headers: { 'Content-Type': mime }, body: data });
    if (!response.ok) throw await failure(response, 'upload a file');
  }

  async function list(): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    let pageToken: string | null = null;
    do {
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        q: 'trashed = false',
        fields: 'nextPageToken, files(name, size)',
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await drive(`${DRIVE}/files?${params}`);
      if (!response.ok) throw await failure(response, 'list your files');
      const page = (await response.json()) as { files?: Array<{ name: string; size?: string }>; nextPageToken?: string };
      for (const file of page.files ?? []) files.push({ id: file.name, size: Number(file.size ?? 0) });
      pageToken = page.nextPageToken ?? null;
    } while (pageToken);
    return files;
  }

  return {
    kind: 'gdrive',

    async upload(id, data, mime) {
      if (await find(id)) return;
      const type = mime || 'application/octet-stream';
      if (data.byteLength > MULTIPART_MAX) return uploadResumable(id, data, type);
      const boundary = `clemnotes-${Math.random().toString(36).slice(2)}`;
      const head = new TextEncoder().encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify({ name: id, parents: ['appDataFolder'], mimeType: type })}\r\n` +
          `--${boundary}\r\nContent-Type: ${type}\r\n\r\n`
      );
      const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
      const response = await drive(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: new Blob([head, data, tail]),
      });
      if (!response.ok) throw await failure(response, 'upload a file');
    },

    async download(id) {
      const fileId = await find(id);
      if (!fileId) return null;
      const response = await drive(`${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media`);
      if (response.status === 404) return null;
      if (!response.ok) throw await failure(response, 'download a file');
      return withSniffedType(await response.blob());
    },

    async remove(ids) {
      let removed = 0;
      for (const id of ids) {
        const fileId = await find(id);
        if (fileId) {
          // Files in the app-data folder are deleted outright, not binned.
          const response = await drive(`${DRIVE}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
          if (!response.ok && response.status !== 404) throw await failure(response, 'delete a file');
        }
        removed += 1;
      }
      return removed;
    },

    list,

    async usage(): Promise<StoreUsage> {
      const files = await list();
      let quota: StoreUsage['quota'] = null;
      const about = await drive(`${DRIVE}/about?fields=storageQuota`).catch(() => null);
      if (about?.ok) {
        const body = (await about.json()) as { storageQuota?: { limit?: string; usage?: string } };
        const total = Number(body.storageQuota?.limit ?? 0);
        // No limit means unlimited storage (some work/school plans): no bar.
        if (total > 0) quota = { used: Number(body.storageQuota?.usage ?? 0), total };
      }
      return { files: files.length, filesBytes: files.reduce((sum, file) => sum + file.size, 0), quota };
    },
  };
}
