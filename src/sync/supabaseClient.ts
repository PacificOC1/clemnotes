import type { SupabaseClient } from '@supabase/supabase-js';
import { checkSyncConfig } from './syncConfig';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const config = checkSyncConfig(url, anonKey);

/**
 * Why sync is off, in words — `null` when it isn't. The sidebar shows this
 * instead of a sign-in form that could only fail.
 */
export const syncConfigProblem: string | null = config.ok ? null : config.problem;

/** False for no config at all *and* for config that is still the template. */
export const isSyncConfigured = config.ok;

let client: Promise<SupabaseClient> | null = null;

/**
 * The Supabase client, loaded on first use (#63).
 *
 * supabase-js is the largest thing in the bundle after the editor itself —
 * auth, storage, PostgREST and realtime clients — and a notebook with sync
 * switched off never needs any of it. Importing it lazily takes it off the
 * first paint for everyone and out of the download entirely for anyone
 * local-only. `null` when sync isn't configured.
 */
export function getSupabase(): Promise<SupabaseClient | null> {
  if (!config.ok) return Promise.resolve(null);
  const { url: projectUrl, anonKey: key } = config;
  client ??= import('@supabase/supabase-js').then(({ createClient }) => createClient(projectUrl, key));
  return client;
}
