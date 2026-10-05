import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/database';
import { getImage, storePdf } from '../../db/imageRepository';
import { resetDatabase } from '../../test/helpers';
import { sniffMime } from './sniff';
import { checkOneDriveConfig, isSignInResponse, redirectUriFor } from './oneDriveConfig';
import { CHUNK_BYTES, createOneDriveStore, GRAPH, SIMPLE_UPLOAD_MAX } from './oneDriveStore';
import { moveFiles } from './moveFiles';
import { FileStoreError, isNeedsSignIn, type FileStore, type FileStoreKind } from './types';
import {
  activeFileStore,
  otherFileStores,
  setStoreConfiguredForTests,
  setActiveFileStore,
  setOneDriveConfiguredForTests,
} from './fileStoreState';
import { loadImageWithReason, removeFromStorage, setFileStoreForTests, uploadPendingImages } from '../imageSync';
import { formatBytes, missingFileMessage } from './messages';

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const pdfBytes = (body = 'hello') => text(`%PDF-1.7\n${body}`).buffer as ArrayBuffer;

/** A store kept in a Map, standing in for Supabase or OneDrive. */
function memoryStore(kind: FileStoreKind, options: { failUploadAfter?: number; needsSignIn?: boolean } = {}) {
  const files = new Map<string, { data: ArrayBuffer; mime: string }>();
  let uploads = 0;
  const guard = () => {
    if (options.needsSignIn) throw new FileStoreError('needs-sign-in', 'Sign in to OneDrive.');
  };
  const store: FileStore & { files: typeof files; downloads: string[] } = {
    kind,
    files,
    downloads: [],
    async upload(id, data, mime) {
      guard();
      if (options.failUploadAfter !== undefined && uploads >= options.failUploadAfter) {
        throw new FileStoreError('failed', "Can't reach OneDrive — you may be offline.");
      }
      uploads += 1;
      files.set(id, { data: data.slice(0), mime });
    },
    async download(id) {
      guard();
      store.downloads.push(id);
      const found = files.get(id);
      return found ? new Blob([found.data], { type: found.mime }) : null;
    },
    async remove(ids) {
      guard();
      for (const id of ids) files.delete(id);
      return ids.length;
    },
    async list() {
      guard();
      return [...files].map(([id, file]) => ({ id, size: file.data.byteLength }));
    },
    async usage() {
      const all = await store.list();
      return { files: all.length, filesBytes: all.reduce((s, f) => s + f.size, 0), quota: null };
    },
  };
  return store;
}

function fakeLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe('telling what a file is from its bytes', () => {
  it('recognises the formats notes hold', () => {
    expect(sniffMime(text('%PDF-1.4 ...'))).toBe('application/pdf');
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe('image/png');
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMime(text('GIF89a'))).toBe('image/gif');
    expect(sniffMime(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffMime(text('<?xml version="1.0"?>\n<!-- drawn -->\n<svg xmlns="http://www.w3.org/2000/svg">'))).toBe(
      'image/svg+xml'
    );
  });

  it('falls back to what it was told for anything else', () => {
    expect(sniffMime(text('just some text'))).toBe('application/octet-stream');
    expect(sniffMime(bytes(), 'image/png')).toBe('image/png');
  });
});

describe('the OneDrive configuration', () => {
  it('wants the app’s client ID, which is a GUID', () => {
    expect(checkOneDriveConfig(undefined)).toMatchObject({ ok: false, absent: true });
    expect(checkOneDriveConfig('  ')).toMatchObject({ ok: false, absent: true });
    expect(checkOneDriveConfig('my-app')).toMatchObject({ ok: false, absent: false });
    expect(checkOneDriveConfig(' 1a2b3c4d-1111-2222-3333-444455556666 ')).toEqual({
      ok: true,
      clientId: '1a2b3c4d-1111-2222-3333-444455556666',
    });
  });

  it('comes back from Microsoft to the app’s own address, answer in the query string', () => {
    expect(redirectUriFor('https://me.github.io', '/clemnotes/')).toBe('https://me.github.io/clemnotes/');
    expect(redirectUriFor('http://localhost:5173', '/')).toBe('http://localhost:5173/');
    expect(isSignInResponse('?code=abc&state=xyz')).toBe(true);
    expect(isSignInResponse('?error=access_denied&state=xyz')).toBe(true);
    expect(isSignInResponse('')).toBe(false);
    expect(isSignInResponse('?code=abc')).toBe(false);
  });
});

describe('OneDrive through Microsoft Graph', () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

  function fakeGraph(handler: (call: Call) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: (init?.headers as Record<string, string>) ?? {},
        body: init?.body,
      };
      calls.push(call);
      return handler(call);
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('uploads a small file in one request, named by its id, in the app folder', async () => {
    const graph = fakeGraph(() => json({ id: 'x' }, 201));
    const store = createOneDriveStore({ getToken: async () => 'token-1', fetchImpl: graph.fetchImpl });
    await store.upload('abc-123', pdfBytes(), 'application/pdf');
    expect(graph.calls).toHaveLength(1);
    expect(graph.calls[0]).toMatchObject({
      url: `${GRAPH}/me/drive/special/approot:/abc-123:/content`,
      method: 'PUT',
      headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/pdf' },
    });
  });

  it('uploads a big file in chunks, without the token on the pre-authorised address', async () => {
    const size = 2 * CHUNK_BYTES + 10;
    expect(size).toBeGreaterThan(SIMPLE_UPLOAD_MAX);
    const graph = fakeGraph((call) => {
      if (call.url.endsWith(':/createUploadSession')) return json({ uploadUrl: 'https://upload.example/session' });
      return call.url === 'https://upload.example/session' ? json({}, 202) : json({}, 500);
    });
    const store = createOneDriveStore({ getToken: async () => 't', fetchImpl: graph.fetchImpl });
    await store.upload('big', new ArrayBuffer(size), 'application/pdf');

    const chunks = graph.calls.filter((call) => call.url === 'https://upload.example/session');
    expect(chunks.map((call) => call.headers['Content-Range'])).toEqual([
      `bytes 0-${CHUNK_BYTES - 1}/${size}`,
      `bytes ${CHUNK_BYTES}-${2 * CHUNK_BYTES - 1}/${size}`,
      `bytes ${2 * CHUNK_BYTES}-${size - 1}/${size}`,
    ]);
    expect(chunks.every((call) => !('Authorization' in call.headers))).toBe(true);
    expect(CHUNK_BYTES % (320 * 1024)).toBe(0);
  });

  it('downloads through the item’s download address and works out the type', async () => {
    const graph = fakeGraph((call) => {
      if (call.url.endsWith('approot:/there')) {
        return json({ '@microsoft.graph.downloadUrl': 'https://download.example/there' });
      }
      if (call.url === 'https://download.example/there') {
        return new Response(pdfBytes('body'), { headers: { 'Content-Type': 'application/octet-stream' } });
      }
      return json({ error: { code: 'itemNotFound' } }, 404);
    });
    const store = createOneDriveStore({ getToken: async () => 't', fetchImpl: graph.fetchImpl });
    const blob = await store.download('there');
    expect(blob?.type).toBe('application/pdf');
    expect(new TextDecoder().decode(await blob!.arrayBuffer())).toContain('body');
    expect(graph.calls.find((call) => call.url.startsWith('https://download.'))?.headers).not.toHaveProperty(
      'Authorization'
    );
    expect(await store.download('missing')).toBeNull();
  });

  it('lists every page of the folder, files only', async () => {
    const graph = fakeGraph((call) => {
      if (call.url.includes('skiptoken')) return json({ value: [{ name: 'c', size: 3, file: {} }] });
      return json({
        value: [
          { name: 'a', size: 1, file: {} },
          { name: 'a-folder', size: 0, folder: {} },
          { name: 'b', size: 2, file: {} },
        ],
        '@odata.nextLink': `${GRAPH}/me/drive/special/approot/children?$skiptoken=2`,
      });
    });
    const store = createOneDriveStore({ getToken: async () => 't', fetchImpl: graph.fetchImpl });
    expect(await store.list()).toEqual([
      { id: 'a', size: 1 },
      { id: 'b', size: 2 },
      { id: 'c', size: 3 },
    ]);
  });

  it('counts a file already gone as removed', async () => {
    const graph = fakeGraph((call) => (call.url.endsWith(':/gone') ? json({}, 404) : new Response(null, { status: 204 })));
    const store = createOneDriveStore({ getToken: async () => 't', fetchImpl: graph.fetchImpl });
    expect(await store.remove(['here', 'gone'])).toBe(2);
    expect(graph.calls.every((call) => call.method === 'DELETE')).toBe(true);
  });

  it('asks for a sign-in when Microsoft turns the token down', async () => {
    const graph = fakeGraph(() => json({ error: { code: 'InvalidAuthenticationToken' } }, 401));
    const store = createOneDriveStore({ getToken: async () => 't', fetchImpl: graph.fetchImpl });
    const err = await store.upload('x', pdfBytes(), 'application/pdf').catch((e: unknown) => e);
    expect(isNeedsSignIn(err)).toBe(true);
  });

  it('waits and tries again when throttled', async () => {
    let first = true;
    const graph = fakeGraph(() => {
      if (first) {
        first = false;
        return new Response(null, { status: 429, headers: { 'Retry-After': '1' } });
      }
      return json({}, 201);
    });
    const waited: number[] = [];
    const store = createOneDriveStore({
      getToken: async () => 't',
      fetchImpl: graph.fetchImpl,
      wait: async (ms) => void waited.push(ms),
    });
    await store.upload('x', pdfBytes(), 'application/pdf');
    expect(waited).toEqual([1000]);
    expect(graph.calls).toHaveLength(2);
  });

  it('says so when the OneDrive is full or the organisation says no', async () => {
    const full = createOneDriveStore({ getToken: async () => 't', fetchImpl: fakeGraph(() => json({}, 507)).fetchImpl });
    await expect(full.upload('x', pdfBytes(), 'application/pdf')).rejects.toThrow(/full/);
    const refused = createOneDriveStore({
      getToken: async () => 't',
      fetchImpl: fakeGraph(() => json({ error: { message: 'Access denied' } }, 403)).fetchImpl,
    });
    await expect(refused.upload('x', pdfBytes(), 'application/pdf')).rejects.toThrow(/organisation/);
  });

  it('gives the drive’s own totals for the meter when it can', async () => {
    const graph = fakeGraph((call) => {
      if (call.url.includes('/me/drive?')) return json({ quota: { used: 500, total: 1_000_000_000_000 } });
      return json({ value: [{ name: 'a', size: 40, file: {} }] });
    });
    const store = createOneDriveStore({ getToken: async () => 't', fetchImpl: graph.fetchImpl });
    expect(await store.usage()).toEqual({ files: 1, filesBytes: 40, quota: { used: 500, total: 1_000_000_000_000 } });
  });
});

describe('moving files between stores', () => {
  beforeEach(resetDatabase);

  it('copies each file across, then deletes the original', async () => {
    const from = memoryStore('supabase');
    const to = memoryStore('onedrive');
    await from.upload('one', pdfBytes('1'), 'application/pdf');
    await from.upload('two', pdfBytes('22'), 'application/pdf');

    const seen: number[] = [];
    const result = await moveFiles(from, to, (p) => seen.push(p.done));
    expect(result).toMatchObject({ done: 2, total: 2, skipped: 0 });
    expect([...to.files.keys()].sort()).toEqual(['one', 'two']);
    expect(from.files.size).toBe(0);
    expect(to.files.get('one')?.mime).toBe('application/pdf');
    expect(seen).toEqual([0, 1, 2]);
  });

  it('sends this device’s copy rather than downloading one', async () => {
    const stored = await storePdf(new Blob([pdfBytes('local')], { type: 'application/pdf' }));
    const from = memoryStore('supabase');
    const to = memoryStore('onedrive');
    await from.upload(stored.id, pdfBytes('local'), 'application/pdf');
    await moveFiles(from, to);
    expect(from.downloads).toEqual([]);
    expect(to.files.has(stored.id)).toBe(true);
  });

  it('stops on a failure with nothing lost, and carries on the next time', async () => {
    const from = memoryStore('supabase');
    await from.upload('a', pdfBytes('a'), 'application/pdf');
    await from.upload('b', pdfBytes('b'), 'application/pdf');
    await from.upload('c', pdfBytes('c'), 'application/pdf');

    const flaky = memoryStore('onedrive', { failUploadAfter: 1 });
    const first = await moveFiles(from, flaky);
    expect(first.done).toBe(1);
    expect(first.error).toMatch(/offline/);
    // Every file is in exactly one place.
    expect(from.files.size + flaky.files.size).toBe(3);

    const steady = memoryStore('onedrive');
    for (const [id, file] of flaky.files) await steady.upload(id, file.data, file.mime);
    const second = await moveFiles(from, steady);
    expect(second).toMatchObject({ done: 2, total: 2 });
    expect(from.files.size).toBe(0);
    expect(steady.files.size).toBe(3);
  });

  it('can be stopped between files', async () => {
    const from = memoryStore('supabase');
    for (const id of ['a', 'b', 'c']) await from.upload(id, pdfBytes(id), 'application/pdf');
    const to = memoryStore('onedrive');
    let stop = false;
    const result = await moveFiles(from, to, (p) => (stop = p.done >= 1), () => stop);
    expect(result.done).toBe(1);
    expect(from.files.size).toBe(2);
  });
});

describe('uploading and fetching through the chosen store', () => {
  let supabase: ReturnType<typeof memoryStore>;
  let onedrive: ReturnType<typeof memoryStore>;

  beforeEach(async () => {
    await resetDatabase();
    vi.stubGlobal('localStorage', fakeLocalStorage());
    setOneDriveConfiguredForTests(true);
    setStoreConfiguredForTests('gdrive', false);
    supabase = memoryStore('supabase');
    onedrive = memoryStore('onedrive');
    setFileStoreForTests('supabase', supabase);
    setFileStoreForTests('onedrive', onedrive);
  });

  afterEach(() => {
    setOneDriveConfiguredForTests(null);
    setStoreConfiguredForTests('gdrive', null);
    setFileStoreForTests('supabase', null);
    setFileStoreForTests('onedrive', null);
    vi.unstubAllGlobals();
  });

  it('defaults to OneDrive when the build has it, and each device can choose', () => {
    expect(activeFileStore()).toBe('onedrive');
    expect(otherFileStores('onedrive')).toEqual(['supabase']);
    setActiveFileStore('supabase');
    expect(activeFileStore()).toBe('supabase');
    setOneDriveConfiguredForTests(false);
    setActiveFileStore('onedrive');
    // A choice this build can't honour falls back rather than breaking uploads.
    expect(activeFileStore()).toBe('supabase');
    expect(otherFileStores('supabase')).toEqual([]);
  });

  it('uploads waiting files to OneDrive and marks them sent', async () => {
    const pdf = await storePdf(new Blob([pdfBytes()], { type: 'application/pdf' }));
    const result = await uploadPendingImages('user-1');
    expect(result).toEqual({ store: 'onedrive', uploaded: 1, pending: 0 });
    expect(onedrive.files.has(pdf.id)).toBe(true);
    expect(supabase.files.size).toBe(0);
    expect((await db.images.get(pdf.id))?.uploadedAt).toBeGreaterThan(0);
  });

  it('keeps files waiting, and says a sign-in is needed, when OneDrive wants one', async () => {
    setFileStoreForTests('onedrive', memoryStore('onedrive', { needsSignIn: true }));
    const pdf = await storePdf(new Blob([pdfBytes()], { type: 'application/pdf' }));
    const result = await uploadPendingImages('user-1');
    expect(result).toMatchObject({ store: 'onedrive', uploaded: 0, pending: 1, needsSignIn: true });
    expect((await db.images.get(pdf.id))?.uploadedAt).toBe(0);
  });

  it('does nothing at all when nothing is waiting', async () => {
    setFileStoreForTests('onedrive', memoryStore('onedrive', { needsSignIn: true }));
    expect(await uploadPendingImages('user-1')).toEqual({ store: 'onedrive', uploaded: 0, pending: 0 });
  });

  it('finds a file in the other store too, so moving never hides one', async () => {
    await supabase.upload('old-one', pdfBytes('from supabase'), 'application/pdf');
    const found = await loadImageWithReason('old-one');
    expect(found.image?.mime).toBe('application/pdf');
    expect(onedrive.downloads).toEqual(['old-one']);
    expect(await getImage('old-one')).toBeDefined();
  });

  it('reports which store wanted a sign-in when a file can’t be found', async () => {
    setFileStoreForTests('onedrive', memoryStore('onedrive', { needsSignIn: true }));
    const found = await loadImageWithReason('nowhere');
    expect(found).toEqual({ needsSignIn: ['onedrive'] });
    expect(missingFileMessage('image', found.needsSignIn)).toMatch(/sign in to OneDrive/);
    expect(missingFileMessage('PDF', [])).toMatch(/isn’t on this device yet/);
  });

  it('cleans up in both stores', async () => {
    await supabase.upload('x', pdfBytes(), 'application/pdf');
    await onedrive.upload('y', pdfBytes(), 'application/pdf');
    const result = await removeFromStorage(['x', 'y']);
    expect(result.error).toBeUndefined();
    expect(supabase.files.size + onedrive.files.size).toBe(0);
  });
});

describe('sizes in words', () => {
  it('reads like a storage plan', () => {
    expect(formatBytes(1_000_000_000)).toBe('1 GB');
    expect(formatBytes(1_099_511_627_776)).toBe('1.1 TB');
    expect(formatBytes(340_200_000)).toBe('340 MB');
    expect(formatBytes(2_450_000)).toBe('2.5 MB');
    expect(formatBytes(12_345)).toBe('12 KB');
    expect(formatBytes(79)).toBe('79 B');
  });
});
