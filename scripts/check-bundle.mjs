// The bundle budget (#63). Run after `vite build`: fails when the JavaScript
// the app needs before it can show anything grows past the budget, so the next
// dependency that adds 400 kB has to be a decision rather than an accident.
//
// "Needed at startup" is worked out from Vite's manifest: the entry, its static
// imports, and `App.tsx` (loaded by main.tsx straight after the pre-upgrade
// snapshot) with its static imports. Lazy views, the importers, KaTeX and
// supabase-js are all outside it. Raise the number in bundle-budget.json on
// purpose when you mean to.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const budget = JSON.parse(readFileSync(new URL('./bundle-budget.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync('dist/.vite/manifest.json', 'utf8'));

const seen = new Set();
function visit(key) {
  if (seen.has(key) || !manifest[key]) return;
  seen.add(key);
  for (const dep of manifest[key].imports ?? []) visit(dep);
}
visit('index.html');
visit('src/App.tsx');

let total = 0;
const rows = [];
for (const key of seen) {
  const file = manifest[key].file;
  if (!file.endsWith('.js')) continue;
  const size = gzipSync(readFileSync(`dist/${file}`)).length;
  total += size;
  rows.push([file, size]);
}
rows.sort((a, b) => b[1] - a[1]);
for (const [file, size] of rows) console.log(`${(size / 1024).toFixed(1).padStart(8)} kB  ${file}`);

const kb = total / 1024;
const limit = budget.startupJsGzipKb;
console.log(`\nStartup JavaScript: ${kb.toFixed(1)} kB gzipped (budget ${limit} kB)`);
if (kb > limit) {
  console.error(`Over budget by ${(kb - limit).toFixed(1)} kB. Split something out, or raise scripts/bundle-budget.json deliberately.`);
  process.exit(1);
}
