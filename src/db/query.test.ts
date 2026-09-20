import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import {
  describeQuery,
  isEmptyQuery,
  matchesRow,
  normalizeQuery,
  parseQuery,
  runQuery,
  serializeQuery,
} from './query';
import { invalidateSearchIndex } from './searchIndex';
import { reconcileCards } from './cardRepository';
import { addChild, addTextNode, resetDatabase, textDoc } from '../test/helpers';
import { createEmptyNode, type OutlinerNode } from './schema';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function row(overrides: Partial<OutlinerNode> = {}): OutlinerNode {
  return {
    ...createEmptyNode(),
    id: 'x',
    plainText: 'some text',
    updatedAt: NOW,
    ...overrides,
  } as OutlinerNode;
}

describe('the filter shape', () => {
  it('treats a filter with no predicates as no question', () => {
    expect(isEmptyQuery({})).toBe(true);
    expect(isEmptyQuery({ text: '   ' })).toBe(true);
    expect(isEmptyQuery({ limit: 10 })).toBe(true);
    expect(isEmptyQuery({ hasCards: true })).toBe(false);
  });

  it('round-trips through the node attribute', () => {
    const query = { text: 'atp', hasCards: true, editedWithinDays: 7 };
    expect(parseQuery(serializeQuery(query))).toEqual(query);
  });

  it('reads anything unusable as an empty filter', () => {
    // A query block is content, and content arrives from sync and from
    // backups — it cannot be trusted to be well formed.
    expect(parseQuery('not json')).toEqual({});
    expect(parseQuery(undefined)).toEqual({});
    expect(parseQuery('42')).toEqual({});
    expect(normalizeQuery({ editedWithinDays: -3, hasCards: 'yes', text: '  ' })).toEqual({});
  });

  it('keeps only whole positive day counts', () => {
    expect(normalizeQuery({ editedWithinDays: 7.8 }).editedWithinDays).toBe(7);
    expect(normalizeQuery({ editedWithinDays: 0 }).editedWithinDays).toBeUndefined();
  });
});

describe('matchesRow', () => {
  it('excludes tombstones, portals and empty rems', () => {
    const q = { hasCards: false, editedWithinDays: 365 };
    expect(matchesRow(row({ deletedAt: NOW }), q, NOW)).toBe(false);
    expect(matchesRow(row({ isPortal: true }), q, NOW)).toBe(false);
    expect(matchesRow(row({ plainText: '   ' }), q, NOW)).toBe(false);
    expect(matchesRow(row(), q, NOW)).toBe(true);
  });

  it('honours hasCards', () => {
    expect(matchesRow(row({ isCard: false }), { hasCards: true }, NOW)).toBe(false);
    expect(matchesRow(row({ isCard: true }), { hasCards: true }, NOW)).toBe(true);
  });

  it('honours the edited window, inclusive of the cutoff', () => {
    const q = { editedWithinDays: 7 };
    expect(matchesRow(row({ updatedAt: NOW - 6 * DAY }), q, NOW)).toBe(true);
    expect(matchesRow(row({ updatedAt: NOW - 7 * DAY }), q, NOW)).toBe(true);
    expect(matchesRow(row({ updatedAt: NOW - 8 * DAY }), q, NOW)).toBe(false);
  });

  it('honours linksTo', () => {
    const q = { linksTo: 'target' };
    expect(matchesRow(row({ outboundLinks: ['target'] }), q, NOW)).toBe(true);
    expect(matchesRow(row({ outboundLinks: ['other'] }), q, NOW)).toBe(false);
  });

  it('requires every predicate, not any of them', () => {
    const q = { hasCards: true, editedWithinDays: 1 };
    expect(matchesRow(row({ isCard: true, updatedAt: NOW - 5 * DAY }), q, NOW)).toBe(false);
    expect(matchesRow(row({ isCard: false, updatedAt: NOW }), q, NOW)).toBe(false);
    expect(matchesRow(row({ isCard: true, updatedAt: NOW }), q, NOW)).toBe(true);
  });
});

describe('running a query', () => {
  beforeEach(async () => {
    await resetDatabase();
    invalidateSearchIndex();
  });

  async function notebook() {
    const bio = await addTextNode('bio', 'Biology', { isPage: true, order: 1 });
    await addChild(bio, 'atp', 'Mitochondria make ATP');
    const card = await addChild(bio, 'card', 'Chloroplast :: photosynthesis', {
      content: textDoc('Chloroplast :: photosynthesis'),
    });
    await reconcileCards(card);

    const hist = await addTextNode('hist', 'History', { isPage: true, order: 2 });
    await addChild(hist, 'magna', 'Magna Carta was 1215');
    return { bio, hist };
  }

  it('answers nothing for an empty filter', async () => {
    await notebook();
    expect(await runQuery({})).toEqual([]);
  });

  it('finds rems by text', async () => {
    await notebook();
    expect((await runQuery({ text: 'mitochondria' })).map((r) => r.node.id)).toEqual(['atp']);
  });

  it('finds rems that make flashcards', async () => {
    await notebook();
    expect((await runQuery({ hasCards: true })).map((r) => r.node.id)).toEqual(['card']);
  });

  it('scopes to one document', async () => {
    await notebook();
    const inBio = await runQuery({ hasCards: false, editedWithinDays: 365, inPage: 'bio' });
    expect(inBio.map((r) => r.node.id).sort()).toEqual(['atp', 'card']);
  });

  it('says which document each result came from', async () => {
    await notebook();
    const [hit] = await runQuery({ text: 'magna' });
    expect(hit?.pageId).toBe('hist');
  });

  it('combines predicates', async () => {
    await notebook();
    expect(await runQuery({ hasCards: true, inPage: 'hist' })).toEqual([]);
    expect((await runQuery({ hasCards: true, inPage: 'bio' })).map((r) => r.node.id)).toEqual(['card']);
  });

  it('excludes rems edited before the window', async () => {
    await notebook();
    await db.nodes.update('atp', { updatedAt: Date.now() - 40 * DAY });
    const recent = await runQuery({ editedWithinDays: 7 });
    expect(recent.map((r) => r.node.id)).not.toContain('atp');
  });

  it('honours a limit', async () => {
    const page = await addTextNode('p', 'Page', { isPage: true, order: 1 });
    for (let i = 0; i < 10; i++) await addChild(page, `n${i}`, `Rem number ${i}`);
    expect(await runQuery({ editedWithinDays: 365, limit: 4 })).toHaveLength(4);
  });

  it('leaves deleted rems out of the answer', async () => {
    await notebook();
    await db.nodes.update('atp', { deletedAt: Date.now() });
    expect(await runQuery({ text: 'mitochondria' })).toEqual([]);
  });
});

describe('describeQuery', () => {
  it('reads as a sentence', () => {
    expect(describeQuery({ text: 'atp' })).toBe('Rems matching “atp”');
    expect(describeQuery({ hasCards: true, editedWithinDays: 7 })).toBe(
      'Rems with flashcards, edited in the last 7 days'
    );
    expect(describeQuery({ editedWithinDays: 1 })).toBe('Rems edited today');
    expect(describeQuery({ inPage: 'x' }, 'Biology')).toBe('Rems in Biology');
  });

  it('says so when there is no filter', () => {
    expect(describeQuery({})).toBe('No filter set');
  });
});
