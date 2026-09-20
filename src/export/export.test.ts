import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/database';
import { buildBackup, liveCounts, serializeBackup } from './backup';
import { BackupParseError, importBackup, parseBackup } from './importBackup';
import { buildExportTrees } from './tree';
import { docToMarkdown, pagesToMarkdown } from './markdown';
import { reconcileCards } from '../db/cardRepository';
import { parseDoc } from '../tiptap/docUtils';
import { addChild, addTextNode, resetDatabase } from '../test/helpers';

/** A rem exercising every inline construct the exporter has to preserve. */
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

/** A small notebook: a page, a card rem with a child, a rich rem, a portal, a tombstone. */
async function seedNotebook() {
  const page = await addTextNode('page-1', 'Maths', { isPage: true, order: 1 });
  const card = await addChild(page, 'rem-card', 'Mitochondrion :: the powerhouse of the cell');
  const rich = await addChild(page, 'rem-rich', 'The derivative of x^2 is 2x, see Calculus.', {
    content: richDoc(),
  });
  await addChild(card, 'rem-child', 'A nested rem');
  await addChild(page, 'rem-portal', '', { isPortal: true, portalTargetId: rich.id });
  await addChild(page, 'rem-deleted', 'Deleted, should not appear', { deletedAt: Date.now() });

  await reconcileCards(card);
  await reconcileCards(rich);
  return { page, card, rich };
}

beforeEach(resetDatabase);

describe('Markdown export', () => {
  it('preserves the constructs that can be written back', async () => {
    const { rich } = await seedNotebook();
    const md = pagesToMarkdown(await buildExportTrees());

    expect(md).toContain('# Maths');
    expect(md).toContain('Mitochondrion :: the powerhouse of the cell');
    expect(md).toContain('[[Calculus]]');
    expect(md).toContain('$x^2$');
    expect(md).toContain('{{2x}}');
    expect(md).toContain('**derivative**');
    expect(md).toContain('```ts');
    expect(md).toContain('const a = 1;');
    expect(md).toContain('![[');

    expect(md).not.toContain('should not appear');
    expect(md).toMatch(/\n {2}- A nested rem/);

    const inner = docToMarkdown(parseDoc(rich.content));
    expect(inner).toContain('- first');
    expect(inner).toContain('- second');
  });

  it('escapes only what is genuinely Markdown syntax', async () => {
    // Escaping every significant character produces `3\.5x \- 1 \(approx\)`,
    // which is correct and unreadable.
    const page = await addTextNode('page-1', 'Notes', { isPage: true, order: 1 });
    await addChild(page, 'rem', 'Use 3.5x - 1 (approx) with snake_case and *stars*');

    const md = pagesToMarkdown(await buildExportTrees());
    expect(md).toContain('3.5x - 1 (approx)');
    expect(md).toContain('snake_case');
    expect(md).toContain('\\*stars\\*');
  });
});

describe('JSON backup', () => {
  it('round-trips the whole database byte for byte', async () => {
    await seedNotebook();
    const backup = await buildBackup();
    const text = serializeBackup(backup);

    expect(backup.format).toBe('clemnotes-backup');
    expect(backup.counts.nodes).toBe(6);
    // Tombstones are included on purpose: a restore that quietly undeleted
    // things would resurrect them on the next sync.
    expect(liveCounts(backup.data).nodes).toBe(5);

    const reparsed = parseBackup(text);
    expect(reparsed.data).toEqual(backup.data);

    await Promise.all([db.nodes.clear(), db.cards.clear(), db.reviews.clear()]);
    expect(await db.nodes.count()).toBe(0);

    await importBackup(reparsed, 'merge');
    expect(await db.nodes.count()).toBe(6);
    expect(await db.cards.count()).toBe(backup.counts.cards);

    const afterRestore = await buildBackup();
    expect(afterRestore.data).toEqual(backup.data);
  });

  it('merges by the same rule sync does — newer updatedAt wins', async () => {
    // If a restore resolved conflicts differently from a sync, restoring on a
    // synced device would produce a state neither device agreed on.
    const { page } = await seedNotebook();
    const snapshot = parseBackup(serializeBackup(await buildBackup()));

    const newer = 'Edited after the backup was taken';
    await db.nodes.update(page.id, { plainText: newer, updatedAt: Date.now() + 10_000 });

    const report = await importBackup(snapshot, 'merge');
    expect((await db.nodes.get(page.id))?.plainText).toBe(newer);
    expect(report.added).toBe(0);
    expect(report.kept).toBeGreaterThan(0);
  });
});

describe('rejecting bad input', () => {
  const rejects = (label: string, input: string) =>
    it(label, () => expect(() => parseBackup(input)).toThrow(BackupParseError));

  rejects('non-JSON', 'not json at all');
  rejects('JSON that is not a backup', '{"hello":"world"}');
  rejects(
    'a format version from the future',
    JSON.stringify({ format: 'clemnotes-backup', formatVersion: 99, data: {} })
  );
  rejects(
    'a row with no id',
    JSON.stringify({ format: 'clemnotes-backup', formatVersion: 1, data: { nodes: [{ updatedAt: 1 }] } })
  );
  rejects(
    'a row with no updatedAt',
    JSON.stringify({ format: 'clemnotes-backup', formatVersion: 1, data: { nodes: [{ id: 'x' }] } })
  );

  it('accepts a backup taken before the reviews table existed', () => {
    const older = parseBackup(
      JSON.stringify({ format: 'clemnotes-backup', formatVersion: 1, schemaVersion: 8, data: { nodes: [] } })
    );
    expect(older.data.reviews).toEqual([]);
  });
});
