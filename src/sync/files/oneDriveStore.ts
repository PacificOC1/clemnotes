import { withSniffedType } from './sniff';
import { FileStoreError, type FileStore, type RemoteFile, type StoreUsage } from './types';

/**
 * Files in the app's own OneDrive folder, through Microsoft Graph.
 *
 * Everything is addressed through `special/approot` — `Apps/<app name>` in
 * the OneDrive, created on first use — which is all the
 * `Files.ReadWrite.AppFolder` permission reaches. Works the same for personal
 * and work/school OneDrives. Each file is named by its id, nothing else.
 *
 * `getToken` and `fetchImpl` are passed in so tests can run it against a
 * fake Graph.
 */

export const GRAPH = 'https://graph.microsoft.com/v1.0';
const APPROOT = '/me/drive/special/approot';

/** Graph's simple upload takes more, but past this an upload session copes better with a bad connection. */
export const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
/** Upload-session chunks must be a multiple of 320 KiB. */
export const CHUNK_BYTES = 320 * 1024 * 16;

type Fetch = typeof fetch;

function itemPath(id: string): string {
  return `${APPROOT}:/${encodeURIComponent(id)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OneDriveStoreOptions {
  getToken: () => Promise<string>;
  fetchImpl?: Fetch;
  /** Waits between retries of a throttled request; tests pass a no-op. */
  wait?: (ms: number) => Promise<void>;
}

export function createOneDriveStore({ getToken, fetchImpl, wait = sleep }: OneDriveStoreOptions): FileStore {
  const doFetch: Fetch = (input, init) => (fetchImpl ?? fetch)(input, init);

  /** A Graph call, with the token, and patience for throttling. */
  async function graph(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
    for (let attempt = 0; ; attempt += 1) {
      const token = await getToken();
      let response: Response;
      try {
        response = await doFetch(url, {
          ...init,
          headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
        });
      } catch {
        throw new FileStoreError('failed', "Can't reach OneDrive — you may be offline.");
      }
      if (response.status === 401) {
        throw new FileStoreError('needs-sign-in', 'OneDrive turned the sign-in down — sign in again on this device.');
      }
      if ((response.status === 429 || response.status === 503) && attempt < 3) {
        const after = Number(response.headers.get('Retry-After'));
        await wait(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * (attempt + 1), 30_000));
        continue;
      }
      return response;
    }
  }

  async function failure(response: Response, what: string): Promise<FileStoreError> {
    let detail = '';
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      detail = body.error?.message ?? body.error?.code ?? '';
    } catch {
      // Not JSON; the status says enough.
    }
    if (response.status === 403) {
      return new FileStoreError(
        'failed',
        `OneDrive refused to ${what}${detail ? `: ${detail}` : ''}. Your organisation may not allow apps to use its OneDrive.`
      );
    }
    if (response.status === 507) return new FileStoreError('failed', 'Your OneDrive is full.');
    return new FileStoreError('failed', `OneDrive couldn't ${what} (${response.status}${detail ? `: ${detail}` : ''}).`);
  }

  async function uploadInSession(id: string, data: ArrayBuffer): Promise<void> {
    const created = await graph(`${itemPath(id)}:/createUploadSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    });
    if (!created.ok) throw await failure(created, 'start an upload');
    const { uploadUrl } = (await created.json()) as { uploadUrl?: string };
    if (!uploadUrl) throw new FileStoreError('failed', 'OneDrive didn’t return an upload address.');

    const total = data.byteLength;
    try {
      for (let start = 0; start < total; start += CHUNK_BYTES) {
        const end = Math.min(start + CHUNK_BYTES, total);
        // The upload URL is pre-authorised: sending the token to it is an error.
        const response = await doFetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${start}-${end - 1}/${total}` },
          body: data.slice(start, end),
        });
        if (!response.ok) throw await failure(response, 'upload a file');
      }
    } catch (err) {
      void doFetch(uploadUrl, { method: 'DELETE' }).catch(() => undefined);
      if (err instanceof FileStoreError) throw err;
      throw new FileStoreError('failed', "Can't reach OneDrive — you may be offline.");
    }
  }

  async function list(): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    let next: string | null = `${APPROOT}/children?$select=name,size,file&$top=200`;
    while (next) {
      const response = await graph(next);
      if (!response.ok) throw await failure(response, 'list your files');
      const page = (await response.json()) as {
        value?: Array<{ name: string; size?: number; file?: unknown }>;
        '@odata.nextLink'?: string;
      };
      for (const item of page.value ?? []) {
        if (item.file) files.push({ id: item.name, size: item.size ?? 0 });
      }
      next = page['@odata.nextLink'] ?? null;
    }
    return files;
  }

  return {
    kind: 'onedrive',

    async upload(id, data, mime) {
      if (data.byteLength > SIMPLE_UPLOAD_MAX) return uploadInSession(id, data);
      const response = await graph(`${itemPath(id)}:/content`, {
        method: 'PUT',
        headers: { 'Content-Type': mime || 'application/octet-stream' },
        body: data,
      });
      if (!response.ok) throw await failure(response, 'upload a file');
    },

    async download(id) {
      const response = await graph(itemPath(id));
      if (response.status === 404) return null;
      if (!response.ok) throw await failure(response, 'find a file');
      const item = (await response.json()) as { '@microsoft.graph.downloadUrl'?: string };
      const downloadUrl = item['@microsoft.graph.downloadUrl'];
      if (!downloadUrl) return null;
      // Pre-authorised and short-lived; fetched without the token.
      let bytes: Response;
      try {
        bytes = await doFetch(downloadUrl);
      } catch {
        throw new FileStoreError('failed', "Can't reach OneDrive — you may be offline.");
      }
      if (!bytes.ok) throw await failure(bytes, 'download a file');
      return withSniffedType(await bytes.blob());
    },

    async remove(ids) {
      let removed = 0;
      for (const id of ids) {
        const response = await graph(itemPath(id), { method: 'DELETE' });
        if (response.ok || response.status === 404) removed += 1;
        else throw await failure(response, 'delete a file');
      }
      return removed;
    },

    list,

    async usage(): Promise<StoreUsage> {
      const files = await list();
      let quota: StoreUsage['quota'] = null;
      // The drive's totals — readable with app-folder access on most
      // accounts; when not, the meter shows only Clemnotes' own share.
      const drive = await graph('/me/drive?$select=quota').catch(() => null);
      if (drive?.ok) {
        const body = (await drive.json()) as { quota?: { used?: number; total?: number } };
        if (body.quota?.total) quota = { used: body.quota.used ?? 0, total: body.quota.total };
      }
      return {
        files: files.length,
        filesBytes: files.reduce((sum, file) => sum + file.size, 0),
        quota,
      };
    },
  };
}
