/**
 * End-to-end check of the export/import path and the review log, run in Node
 * against `fake-indexeddb`.
 *
 * There is no test runner in this project yet (roadmap item 59). This is the
 * same technique the LaTeX seeder was verified with: every module under
 * `src/db` and `src/export` is browser-free apart from the IndexedDB global,
 * so the whole data layer can be exercised in Node by bundling it with esbuild
 * and supplying that one global.
 *
 *   npx esbuild scripts/verify-export.ts --bundle --platform=node \
 *     --outfile=/tmp/verify.cjs && node /tmp/verify.cjs
 */
import 'fake-indexeddb/auto';
import { db } from '../src/db/database';
import { createEmptyNode, type Flashcard, type OutlinerNode } from '../src/db/schema';
import { reconcileCards, gradeCard, getDueCards } from '../src/db/cardRepository';
import { getReviewsForCard, summarizeReviews, getAllReviews } from '../src/db/reviewRepository';
import { buildBackup, serializeBackup, liveCounts } from '../src/export/backup';
import { parseBackup, importBackup, BackupParseError } from '../src/export/importBackup';
import { buildExportTrees } from '../src/export/tree';
import { pagesToMarkdown, docToMarkdown } from '../src/export/markdown';
import { parseDoc } from '../src/tiptap/docUtils';

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

function section(name: string) {
  console.log(`\n${name}`);
}

function textDoc(text: string) {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
}

function richDoc() {
  return JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'The ' },
          { type: 'text', text: 'derivative', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' of ' },
          { type: 'math', attrs: { latex: 'x^2' } },
          { type: 'text', text: ' is ' },
          { type: 'cloze', attrs: { index: 1, text: '2x' } },
          { type: 'text', text: ', see ' },
          { type: 'wikiLink', attrs: { title: 'Calculus' } },
          { type: 'text', text: '.' },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1;' }] },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
        ],
      },
    ],
  });
}

async function addNode(overrides: Partial<OutlinerNode> & { id: string }): Promise<OutlinerNode> {
  const node = { ...createEmptyNode(), ...overrides } as OutlinerNode;
  await db.nodes.add(node);
  return node;
}

async function main() {
  // ------------------------------------------------------------------ setup
  section('Seeding a small notebook');
  const page = await addNode({
    id: 'page-1',
    content: textDoc('Maths'),
    plainText: 'Maths',
    isPage: true,
    order: 1,
  });
  const card = await addNode({
    id: 'rem-card',
    content: textDoc('Mitochondrion :: the powerhouse of the cell'),
    plainText: 'Mitochondrion :: the powerhouse of the cell',
    parentId: page.id,
    order: 1,
  });
  const rich = await addNode({
    id: 'rem-rich',
    content: richDoc(),
    plainText: 'The derivative of x^2 is 2x, see Calculus.',
    parentId: page.id,
    order: 2,
  });
  await addNode({
    id: 'rem-child',
    content: textDoc('A nested rem'),
    plainText: 'A nested rem',
    parentId: card.id,
    order: 1,
  });
  await addNode({
    id: 'rem-portal',
    parentId: page.id,
    order: 3,
    isPortal: true,
    portalTargetId: rich.id,
  });
  await addNode({
    id: 'rem-deleted',
    content: textDoc('Deleted, should not appear in Markdown'),
    plainText: 'Deleted, should not appear in Markdown',
    parentId: page.id,
    order: 4,
    deletedAt: Date.now(),
  });

  await reconcileCards(card);
  await reconcileCards(rich);
  check('a `::` rem produced a card', (await db.cards.where('nodeId').equals(card.id).count()) === 1);
  check('a cloze rem produced a card', (await db.cards.where('nodeId').equals(rich.id).count()) === 1);

  // ------------------------------------------------------------ review log
  section('Review log (#29)');
  const due = await getDueCards();
  check('both new cards are due', due.length === 2, due.length);

  const target = due.find((c) => c.nodeId === card.id) as Flashcard;
  const before = await db.cards.get(target.id);
  await gradeCard(target.id, 4);
  const after = await db.cards.get(target.id);
  const log = await getReviewsForCard(target.id);

  check('grading wrote exactly one log row', log.length === 1, log.length);
  check('the row records the grade', log[0]?.grade === 4);
  check('the row records the pre-review state', log[0]?.state === 'new', log[0]?.state);
  check('elapsedMs is null on a first review', log[0]?.elapsedMs === null);
  check(
    'before/after intervals bracket the reschedule',
    log[0]?.intervalBefore === before?.interval && log[0]?.intervalAfter === after?.interval,
    { logged: [log[0]?.intervalBefore, log[0]?.intervalAfter], card: [before?.interval, after?.interval] }
  );
  check('the card actually moved on', (after?.dueAt ?? 0) > (before?.dueAt ?? 0));

  await gradeCard(target.id, 0);
  const log2 = await getReviewsForCard(target.id);
  check('a second review appends rather than replaces', log2.length === 2, log2.length);
  check('the lapse is recorded as such', log2[1]?.grade === 0);
  check('elapsedMs is set on the second review', typeof log2[1]?.elapsedMs === 'number');
  check(
    'the second review saw the state the first one left',
    log2[1]?.intervalBefore === log2[0]?.intervalAfter
  );

  const summary = summarizeReviews(await getAllReviews());
  check('summary counts both reviews', summary.reviews === 2, summary.reviews);
  check(
    'retention excludes the first sight of a new card',
    summary.retention === 0,
    summary.retention
  );
  check('summary counts the lapse', summary.lapses === 1);

  // ------------------------------------------------------------- markdown
  section('Markdown export (#25)');
  const trees = await buildExportTrees();
  check('one page tree', trees.length === 1, trees.length);
  const md = pagesToMarkdown(trees);

  check('page title becomes a heading', md.includes('# Maths'));
  check('cards keep their :: syntax', md.includes('Mitochondrion :: the powerhouse of the cell'));
  check('wiki links survive', md.includes('[[Calculus]]'));
  check('maths survives', md.includes('$x^2$'));
  check('clozes survive in re-creatable form', md.includes('{{2x}}'));
  check('bold survives', md.includes('**derivative**'));
  check('code blocks survive', md.includes('```ts') && md.includes('const a = 1;'));
  check('portals name their target', md.includes('![['));
  check('deleted rems are excluded', !md.includes('should not appear'));
  check('nesting is indented', /\n {2}- A nested rem/.test(md), md.split('\n').slice(0, 12));

  const inner = docToMarkdown(parseDoc(rich.content));
  check('nested bullet lists inside a rem render', inner.includes('- first') && inner.includes('- second'));

  // --------------------------------------------------------- json backup
  section('JSON backup round-trip (#25)');
  const backup = await buildBackup();
  const text = serializeBackup(backup);
  check('backup declares its format', backup.format === 'clemnotes-backup');
  check('backup includes tombstones', backup.counts.nodes === 6, backup.counts.nodes);
  check('live counts exclude tombstones', liveCounts(backup.data).nodes === 5);
  check('backup includes the review log', backup.counts.reviews === 2, backup.counts.reviews);

  const reparsed = parseBackup(text);
  check(
    'a backup re-parses to the same rows',
    JSON.stringify(reparsed.data) === JSON.stringify(backup.data)
  );

  // Wipe and restore.
  await Promise.all([db.nodes.clear(), db.cards.clear(), db.reviews.clear(), db.dictionary.clear(), db.folders.clear()]);
  check('database is empty before the restore', (await db.nodes.count()) === 0);

  const restored = await importBackup(reparsed, 'merge');
  check('restore added every row', restored.added === 6 + backup.counts.cards + 2, restored);
  check('rems came back', (await db.nodes.count()) === 6);
  check('cards came back', (await db.cards.count()) === backup.counts.cards);
  check('the review log came back', (await db.reviews.count()) === 2);

  const afterRestore = await buildBackup();
  check(
    'restored database serialises identically',
    JSON.stringify(afterRestore.data) === JSON.stringify(backup.data)
  );

  // ------------------------------------------------------- merge semantics
  section('Merge semantics');
  const newerText = 'Edited after the backup was taken';
  await db.nodes.update(page.id, { plainText: newerText, updatedAt: Date.now() + 10_000 });
  const secondImport = await importBackup(reparsed, 'merge');
  const pageNow = await db.nodes.get(page.id);
  check('a newer local row is kept', pageNow?.plainText === newerText, pageNow?.plainText);
  check('and is counted as kept, not updated', secondImport.kept > 0, secondImport);
  check('re-importing adds nothing new', secondImport.added === 0, secondImport.added);

  // ------------------------------------------------------------ bad input
  section('Rejecting bad input');
  const rejects = (label: string, input: string) => {
    try {
      parseBackup(input);
      check(label, false, 'accepted');
    } catch (err) {
      check(label, err instanceof BackupParseError, String(err));
    }
  };
  rejects('rejects non-JSON', 'not json at all');
  rejects('rejects JSON that is not a backup', '{"hello":"world"}');
  rejects(
    'rejects a future format version',
    JSON.stringify({ format: 'clemnotes-backup', formatVersion: 99, data: {} })
  );
  rejects(
    'rejects rows with no id',
    JSON.stringify({ format: 'clemnotes-backup', formatVersion: 1, data: { nodes: [{ updatedAt: 1 }] } })
  );
  rejects(
    'rejects rows with no updatedAt',
    JSON.stringify({ format: 'clemnotes-backup', formatVersion: 1, data: { nodes: [{ id: 'x' }] } })
  );

  const older = parseBackup(
    JSON.stringify({ format: 'clemnotes-backup', formatVersion: 1, schemaVersion: 8, data: { nodes: [] } })
  );
  check('accepts a backup taken before the reviews table existed', older.data.reviews.length === 0);

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
