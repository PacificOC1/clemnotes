import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/**
 * Installable and offline (#56).
 *
 * The app was already local-first once loaded — everything lives in
 * IndexedDB — but a cold load with no connection failed, because the page
 * and its scripts came from the network. This plugin writes a service worker
 * at build time that knows every file the build emitted:
 *
 * - **Precached on install:** the page, every script and stylesheet, and the
 *   woff2 fonts — so the app opens offline after one visit, including views
 *   (flashcards, the importers) you haven't opened yet.
 * - **Not precached:** the SQLite engine the Anki importer uses (650 kB, only
 *   needed on import), `.woff`/`.ttf` fallbacks no current browser picks, and
 *   source maps. Those are cached the first time they're fetched instead.
 * - **The page is network-first**, so a deploy shows up on the next load when
 *   online; everything under `assets/` is content-hashed and so cache-first.
 * - **Other origins** (Supabase) are never touched.
 *
 * The cache name carries a hash of the file list, so a new build replaces the
 * old cache rather than growing beside it.
 */

/** Files from `public/` — copied as they are, so not in the bundle the plugin sees. */
const PUBLIC_FILES = ['favicon.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

const SKIP = [/\.map$/, /\.wasm$/, /\.woff$/, /\.ttf$/, /^\.vite\//, /^sw\.js$/];

export function serviceWorkerSource(files: string[], version: string): string {
  const precache = ['./', ...files.map((f) => `./${f}`)];
  return `// Generated at build time by scripts/service-worker.ts — do not edit.
const CACHE = 'clemnotes-${version}';
const PRECACHE = ${JSON.stringify(precache)};
const INDEX = new URL('./index.html', self.registration.scope).href;
const ROOT = new URL('./', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('clemnotes-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(INDEX, copy));
          }
          return response;
        })
        // Offline: the last page seen, or the one precached at install.
        .catch(() =>
          caches.match(INDEX).then((hit) => hit || caches.match(ROOT)).then((hit) => hit || Response.error())
        )
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok && url.pathname.includes('/assets/')) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
`;
}

export function serviceWorker(): Plugin {
  return {
    name: 'clemnotes-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((name) => !SKIP.some((pattern) => pattern.test(name)))
        .concat(PUBLIC_FILES)
        .sort();
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(files, version) });
    },
  };
}
