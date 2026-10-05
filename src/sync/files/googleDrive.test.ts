import { beforeEach, describe, expect, it } from 'vitest';
import { checkGoogleDriveConfig, googleAuthUrl, isGoogleSignInResponse, pkceChallenge } from './googleDriveConfig';
import { createGoogleDriveStore, DRIVE, DRIVE_UPLOAD, MULTIPART_MAX } from './googleDriveStore';
import { isNeedsSignIn } from './types';
import { isSignInResponse } from './oneDriveConfig';

const pdf = (body = 'x') => new TextEncoder().encode(`%PDF-1.7\n${body}`).buffer as ArrayBuffer;

describe('Google Drive settings', () => {
  it('wants the OAuth client ID, not the secret', () => {
    expect(checkGoogleDriveConfig(undefined)).toMatchObject({ ok: false, absent: true });
    expect(checkGoogleDriveConfig('GOCSPX-abcdef')).toMatchObject({ ok: false, absent: false });
    expect(checkGoogleDriveConfig(' 1234567890-abc123def.apps.googleusercontent.com ')).toEqual({
      ok: true,
      clientId: '1234567890-abc123def.apps.googleusercontent.com',
    });
  });

  it('asks Google for lasting access to the app folder only, with PKCE', async () => {
    const url = new URL(
      googleAuthUrl({ clientId: 'id', redirectUri: 'https://me.github.io/clemnotes/', state: 'gd.s', codeChallenge: 'c' })
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive.appdata');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toContain('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // RFC 7636's own example.
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });

  it('tells Google’s return trip from Microsoft’s', () => {
    expect(isGoogleSignInResponse('?state=gd.abc&code=1&scope=x')).toBe(true);
    expect(isGoogleSignInResponse('?state=gd.abc&error=access_denied')).toBe(true);
    expect(isGoogleSignInResponse('?state=eyJpZCI6IjEifQ&code=1')).toBe(false);
    expect(isSignInResponse('?state=gd.abc&code=1')).toBe(true);
  });
});

describe('Google Drive’s app-data folder', () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body?: BodyInit | null };
  let files: Map<string, { name: string; data: Uint8Array; mime: string }>;
  let calls: Call[];
  let nextId: number;
  let tokens: string[];

  const json = (body: unknown, status = 200) => Response.json(body, { status });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      url: url.href,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body,
    };
    calls.push(call);
    if (call.headers.Authorization !== 'Bearer good') return json({ error: { code: 401 } }, 401);

    if (url.href.startsWith(`${DRIVE}/files?`)) {
      expect(url.searchParams.get('spaces')).toBe('appDataFolder');
      const q = url.searchParams.get('q') ?? '';
      const named = /name = '([^']+)'/.exec(q)?.[1];
      const all = [...files].map(([id, f]) => ({ id, name: f.name, size: String(f.data.length) }));
      return json({ files: named ? all.filter((f) => f.name === named) : all });
    }
    if (url.href.startsWith(`${DRIVE_UPLOAD}/files?uploadType=multipart`)) {
      const raw = new Uint8Array(await new Response(init!.body).arrayBuffer());
      const text = new TextDecoder().decode(raw);
      const meta = JSON.parse(/\{.*\}/.exec(text)![0]) as { name: string; parents: string[]; mimeType: string };
      expect(meta.parents).toEqual(['appDataFolder']);
      const start = text.indexOf('%PDF');
      const end = text.lastIndexOf('\r\n--');
      const id = `drive-${nextId++}`;
      files.set(id, { name: meta.name, data: raw.slice(start, end), mime: meta.mimeType });
      return json({ id });
    }
    if (url.href.startsWith(`${DRIVE_UPLOAD}/files?uploadType=resumable`)) {
      const meta = JSON.parse(String(init!.body)) as { name: string; mimeType: string };
      return new Response(null, { headers: { Location: `https://upload.example/session?name=${meta.name}&mime=${meta.mimeType}` } });
    }
    if (url.origin === 'https://upload.example') {
      const data = new Uint8Array(await new Response(init!.body).arrayBuffer());
      files.set(`drive-${nextId++}`, { name: url.searchParams.get('name')!, data, mime: url.searchParams.get('mime')! });
      return json({ id: 'x' });
    }
    const media = /\/files\/([^/?]+)\?alt=media/.exec(url.href);
    if (media) {
      const f = files.get(decodeURIComponent(media[1]!));
      return f ? new Response(f.data.slice().buffer as ArrayBuffer, { headers: { 'Content-Type': f.mime } }) : json({}, 404);
    }
    const one = /\/files\/([^/?]+)$/.exec(url.href);
    if (one && call.method === 'DELETE') {
      files.delete(decodeURIComponent(one[1]!));
      return new Response(null, { status: 204 });
    }
    if (url.href.startsWith(`${DRIVE}/about`)) return json({ storageQuota: { limit: '16106127360', usage: '1000' } });
    return json({ error: 'unexpected' }, 500);
  }) as typeof fetch;

  const store = () =>
    createGoogleDriveStore({
      getToken: async (force) => {
        const token = tokens.shift() ?? 'good';
        return force ? 'good' : token;
      },
      fetchImpl,
      wait: async () => {},
    });

  beforeEach(() => {
    files = new Map();
    calls = [];
    nextId = 1;
    tokens = [];
  });

  it('uploads into the app folder, named by id, and reads it back with its type', async () => {
    const drive = store();
    await drive.upload('file-a', pdf('hello'), 'application/pdf');
    expect([...files.values()].map((f) => f.name)).toEqual(['file-a']);
    const blob = await drive.download('file-a');
    expect(blob?.type).toBe('application/pdf');
    expect(new TextDecoder().decode(await blob!.arrayBuffer())).toContain('hello');
    expect(await drive.download('nope')).toBeNull();
  });

  it('never makes a second copy of the same id', async () => {
    const drive = store();
    await drive.upload('file-a', pdf(), 'application/pdf');
    await drive.upload('file-a', pdf(), 'application/pdf');
    expect(files.size).toBe(1);
  });

  it('sends a big file as a resumable upload', async () => {
    const big = new Uint8Array(MULTIPART_MAX + 10);
    big.set(new TextEncoder().encode('%PDF-'));
    await store().upload('big', big.buffer, 'application/pdf');
    expect(calls.some((c) => c.url.includes('uploadType=resumable'))).toBe(true);
    expect([...files.values()][0]?.data.length).toBe(MULTIPART_MAX + 10);
  });

  it('lists, measures and removes', async () => {
    const drive = store();
    await drive.upload('a', pdf('1'), 'application/pdf');
    await drive.upload('b', pdf('22'), 'application/pdf');
    expect((await drive.list()).map((f) => f.id).sort()).toEqual(['a', 'b']);
    const usage = await drive.usage();
    expect(usage.files).toBe(2);
    expect(usage.quota).toEqual({ used: 1000, total: 16106127360 });
    expect(await drive.remove(['a', 'gone'])).toBe(2);
    expect((await drive.list()).map((f) => f.id)).toEqual(['b']);
  });

  it('gets a fresh token once when Drive turns one down', async () => {
    tokens = ['stale'];
    await store().upload('a', pdf(), 'application/pdf');
    expect(files.size).toBe(1);
  });

  it('asks to connect again when even a fresh token is refused', async () => {
    const drive = createGoogleDriveStore({ getToken: async () => 'bad', fetchImpl, wait: async () => {} });
    const err = await drive.list().catch((e: unknown) => e);
    expect(isNeedsSignIn(err)).toBe(true);
  });

  it('explains a full Drive and a switched-off API', async () => {
    const full = createGoogleDriveStore({
      getToken: async () => 'good',
      fetchImpl: (async () =>
        Response.json({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } }, { status: 403 })) as typeof fetch,
      wait: async () => {},
    });
    await expect(full.list()).rejects.toThrow(/full/);
    const off = createGoogleDriveStore({
      getToken: async () => 'good',
      fetchImpl: (async () =>
        Response.json(
          { error: { errors: [{ reason: 'accessNotConfigured' }], message: 'Google Drive API has not been used in project 1' } },
          { status: 403 }
        )) as typeof fetch,
      wait: async () => {},
    });
    await expect(off.list()).rejects.toThrow(/Drive API/);
  });
});
