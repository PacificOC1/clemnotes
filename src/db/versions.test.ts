import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import { EDIT_GAP_MS, MAX_PER_REM, getUnseenConflicts, getVersions, keepVersion, markConflictsSeen, noteEdit } from './versionRepository';
import { getNode, restoreVersion, updateContent } from './repository';
import { addTextNode, resetDatabase, textDoc } from '../test/helpers';
import { findConflicts } from '../sync/merge';

beforeEach(resetDatabase);

const write = (id: string, text: string) => updateContent(id, textDoc(text), text);

describe('keeping versions while editing', () => {
  it('keeps the text from before a burst of editing, once', async () => {
    await addTextNode('rem', 'first draft');
    await write('rem', 'first draft, revised');
    await write('rem', 'first draft, revised again');
    const versions = await getVersions('rem');
    expect(versions.map((v) => v.plainText)).toEqual(['first draft']);
    expect(versions[0]?.reason).toBe('edit');
  });

  it('keeps another after a pause', async () => {
    const node = await addTextNode('rem', 'one');
    const t = Date.now();
    await noteEdit(node, textDoc('two'), t);
    const later = { ...node, content: textDoc('two'), plainText: 'two' };
    await noteEdit(later, textDoc('three'), t + EDIT_GAP_MS + 1);
    expect((await getVersions('rem')).map((v) => v.plainText)).toEqual(['two', 'one']);
  });

  it("doesn't keep empty text, or a write that changes nothing", async () => {
    const empty = await addTextNode('empty', '');
    expect(await noteEdit(empty, textDoc('hello'))).toBe(false);
    const same = await addTextNode('same', 'hello');
    expect(await noteEdit(same, same.content)).toBe(false);
  });

  it(`keeps at most ${MAX_PER_REM} per rem, dropping the oldest`, async () => {
    const node = await addTextNode('rem', 'x');
    for (let i = 0; i < MAX_PER_REM + 5; i++) {
      await keepVersion({ ...node, content: textDoc(`v${i}`), plainText: `v${i}` }, 'edit', {}, 1000 + i);
    }
    const versions = await getVersions('rem');
    expect(versions).toHaveLength(MAX_PER_REM);
    expect(versions[0]?.plainText).toBe(`v${MAX_PER_REM + 4}`);
    expect(versions.at(-1)?.plainText).toBe('v5');
  });
});

describe('restoring', () => {
  it('puts the old text back and keeps the current text as a version', async () => {
    await addTextNode('rem', 'original');
    await write('rem', 'rewritten');
    const [old] = await getVersions('rem');
    await restoreVersion(old!);

    expect((await getNode('rem'))?.plainText).toBe('original');
    const versions = await getVersions('rem');
    expect(versions[0]).toMatchObject({ plainText: 'rewritten', reason: 'restore' });
  });
});

describe('sync conflicts', () => {
  const row = (id: string, content: string, updatedAt: number) => ({ id, content, updatedAt, deletedAt: null });
  const cursor = { pushedThrough: 100, pulledThrough: 100 };
  const differs = (a: { content: string }, b: { content: string }) => a.content !== b.content;

  it('finds rows changed on both sides since the last sync', () => {
    const conflicts = findConflicts([row('a', 'mine', 150)], [row('a', 'theirs', 160)], cursor, differs);
    expect(conflicts).toEqual([expect.objectContaining({ id: 'a', winner: 'remote' })]);
  });

  it('ignores a row only one side changed', () => {
    expect(findConflicts([row('a', 'mine', 50)], [row('a', 'theirs', 160)], cursor, differs)).toEqual([]);
    expect(findConflicts([row('a', 'mine', 150)], [row('a', 'theirs', 90)], cursor, differs)).toEqual([]);
  });

  it('ignores changes that leave the text the same', () => {
    expect(findConflicts([row('a', 'same', 150)], [row('a', 'same', 160)], cursor, differs)).toEqual([]);
  });

  it('keeps the losing text once, unseen until its history is opened', async () => {
    const node = await addTextNode('rem', 'winner');
    const loser = { ...node, content: textDoc('loser'), plainText: 'loser' };
    await keepVersion(loser, 'conflict', { from: 'this device', seen: false });
    await keepVersion(loser, 'conflict', { from: 'this device', seen: false });
    expect(await getUnseenConflicts()).toHaveLength(1);
    await markConflictsSeen('rem');
    expect(await getUnseenConflicts()).toHaveLength(0);
    expect(await db.versions.count()).toBe(1);
  });
});
