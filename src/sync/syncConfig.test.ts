import { describe, expect, it } from 'vitest';
import { checkSyncConfig, describeNetworkError } from './syncConfig';

const REAL_URL = 'https://abcdefghijklmnopqrst.supabase.co';
const REAL_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlhdCI6MTcwMDAwMDAwMH0.abcdefghijklmnopqrstuvwxyz012345';

describe('checkSyncConfig', () => {
  it('accepts a real-looking project', () => {
    expect(checkSyncConfig(REAL_URL, REAL_KEY)).toEqual({ ok: true, url: REAL_URL, anonKey: REAL_KEY });
  });

  it('accepts the newer publishable keys and a local dev stack', () => {
    expect(checkSyncConfig(REAL_URL, 'sb_publishable_0123456789abcdefghijklmnopqrstuv').ok).toBe(true);
    expect(checkSyncConfig('http://127.0.0.1:54321', REAL_KEY).ok).toBe(true);
  });

  it('treats nothing set as the normal local-only state', () => {
    expect(checkSyncConfig(undefined, undefined)).toMatchObject({ ok: false, absent: true });
    expect(checkSyncConfig('  ', '')).toMatchObject({ ok: false, absent: true });
  });

  it('rejects the README template values, naming the variable', () => {
    const url = checkSyncConfig('https://your-project-ref.supabase.co', REAL_KEY);
    expect(url).toMatchObject({ ok: false, absent: false });
    expect(!url.ok && url.problem).toMatch(/VITE_SUPABASE_URL/);

    const key = checkSyncConfig(REAL_URL, 'your-anon-public-key');
    expect(!key.ok && key.problem).toMatch(/VITE_SUPABASE_ANON_KEY/);
  });

  it('rejects half a configuration', () => {
    expect(checkSyncConfig(REAL_URL, '')).toMatchObject({ ok: false, absent: false });
    expect(checkSyncConfig('', REAL_KEY)).toMatchObject({ ok: false, absent: false });
  });

  it('rejects things that are not URLs, or not https', () => {
    expect(checkSyncConfig('supabase', REAL_KEY).ok).toBe(false);
    expect(checkSyncConfig('http://abc.supabase.co', REAL_KEY).ok).toBe(false);
    expect(checkSyncConfig('https://localhostt', REAL_KEY).ok).toBe(false);
  });

  it('rejects a key that was cut off', () => {
    expect(checkSyncConfig(REAL_URL, 'eyJhbGci').ok).toBe(false);
  });
});

describe('describeNetworkError', () => {
  it('turns an unreachable host into advice about the URL', () => {
    expect(describeNetworkError(new TypeError('Failed to fetch'), true)).toMatch(/VITE_SUPABASE_URL/);
    // supabase-js wraps it in its own error type, keeping the message.
    expect(describeNetworkError(new Error('Failed to fetch'), true)).toMatch(/Can't reach/);
  });

  it('says offline when the browser says offline', () => {
    expect(describeNetworkError(new TypeError('Failed to fetch'), false)).toMatch(/offline/);
  });

  it('passes real auth errors through untouched', () => {
    expect(describeNetworkError(new Error('Invalid login credentials'), true)).toBe('Invalid login credentials');
  });
});
