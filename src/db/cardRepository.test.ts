import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './database';
import {
  buildPracticeQueue,
  buildReviewQueue,
  deleteCardsForNode,
  getAllCards,
  getLeeches,
  getCardStats,
  getCardsForNode,
  getDueCards,
  gradeCard,
  reconcileCards,
  resetCard,
  setCardSuspended,
  toggleCardDirection,
} from './cardRepository';
import { getReviewsForCard, getTodayCounts } from './reviewRepository';
import { DEFAULT_SETTINGS } from '../srs/settings';
import { getNode } from './repository';
import { addTextNode, clozeDoc, resetDatabase, textDoc } from '../test/helpers';
import type { OutlinerNode } from './schema';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Put a rem in the database with `content`, and reconcile its cards. */
async function remWith(content: string, overrides: Partial<OutlinerNode> = {}) {
  const node = await addTextNode('rem', 'text', { content, ...overrides });
  await reconcileCards(node);
  return node;
}

/** Change a rem's content and reconcile again, as `updateContent` does. */
async function rewrite(id: string, content: string) {
  await db.nodes.update(id, { content, updatedAt: Date.now() });
  const node = await getNode(id);
  if (node) await reconcileCards(node);
  return node;
}

beforeEach(resetDatabase);

describe('deriving cards from a rem', () => {
  it('makes one card from a `::` rem', async () => {
    await remWith(textDoc('Mitochondrion :: the powerhouse of the cell'));
    const cards = await getCardsForNode('rem');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind).toBe('forward');
    expect(cards[0]?.id).toBe('rem::forward');
  });

  it('makes both directions when the rem asks for them', async () => {
    await remWith(textDoc('Mitochondrion :: powerhouse'), { cardDirection: 'both' });
    expect((await getCardsForNode('rem')).map((c) => c.kind).sort()).toEqual(['backward', 'forward']);
  });

  it('makes one card per cloze', async () => {
    await remWith(clozeDoc([1, 'first'], [2, 'second']));
    const cards = await getCardsForNode('rem');
    expect(cards.map((c) => c.clozeIndex).sort()).toEqual([1, 2]);
    expect(cards.every((c) => c.kind === 'cloze')).toBe(true);
  });

  it('lets a cloze win over a `::` in the same rem', async () => {
    // desiredCards checks clozes first; the app's authoring guardrails rely on
    // this being the rule rather than an accident of ordering.
    const doc = JSON.parse(clozeDoc([1, 'answer']));
    doc.content[0].content.unshift({ type: 'text', text: 'Term :: ' });
    await remWith(JSON.stringify(doc));
    const cards = await getCardsForNode('rem');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind).toBe('cloze');
  });

  it('makes no cards from plain text, a portal or a deleted rem', async () => {
    await remWith(textDoc('just a note'));
    expect(await getCardsForNode('rem')).toHaveLength(0);

    const portal = await addTextNode('portal', '', {
      content: textDoc('A :: B'),
      isPortal: true,
      portalTargetId: 'rem',
    });
    await reconcileCards(portal);
    expect(await getCardsForNode('portal')).toHaveLength(0);

    const gone = await addTextNode('gone', 'A :: B', { content: textDoc('A :: B'), deletedAt: Date.now() });
    await reconcileCards(gone);
    expect(await getCardsForNode('gone')).toHaveLength(0);
  });

  it('flags the rem itself so the outliner can show a card badge', async () => {
    await remWith(textDoc('A :: B'));
    expect((await getNode('rem'))?.isCard).toBe(true);
    await rewrite('rem', textDoc('no longer a card'));
    expect((await getNode('rem'))?.isCard).toBe(false);
  });
});

describe('reconciliation', () => {
  it('is idempotent — re-running never duplicates a card', async () => {
    const node = await remWith(textDoc('A :: B'));
    const first = await getCardsForNode('rem');
    for (let i = 0; i < 5; i++) await reconcileCards(node);
    const again = await getCardsForNode('rem');
    expect(again).toHaveLength(1);
    expect(again[0]?.id).toBe(first[0]?.id);
    expect(again[0]?.createdAt).toBe(first[0]?.createdAt);
  });

  it('keeps scheduling history across a card disappearing and coming back', async () => {
    // Deleting a `::` and undoing it must not reset months of scheduling —
    // this is the whole reason card ids are derived rather than random.
    await remWith(textDoc('A :: B'));
    await gradeCard('rem::forward', 5);
    const graded = await db.cards.get('rem::forward');

    await rewrite('rem', textDoc('A and B'));
    expect(await getCardsForNode('rem')).toHaveLength(0);
    expect((await db.cards.get('rem::forward'))?.deletedAt).toBeTypeOf('number');

    await rewrite('rem', textDoc('A :: B'));
    const back = await db.cards.get('rem::forward');
    expect(back?.deletedAt).toBeNull();
    expect(back?.interval).toBe(graded?.interval);
    expect(back?.easeFactor).toBe(graded?.easeFactor);
    expect(back?.repetitions).toBe(graded?.repetitions);
  });

  it('retires cards for clozes that were removed', async () => {
    await remWith(clozeDoc([1, 'a'], [2, 'b']));
    expect(await getCardsForNode('rem')).toHaveLength(2);
    await rewrite('rem', clozeDoc([1, 'a']));
    const live = await getCardsForNode('rem');
    expect(live).toHaveLength(1);
    expect(live[0]?.clozeIndex).toBe(1);
  });

  it('adds and removes the reverse card as the direction is toggled', async () => {
    await remWith(textDoc('A :: B'));
    await toggleCardDirection('rem');
    expect(await getCardsForNode('rem')).toHaveLength(2);
    await toggleCardDirection('rem');
    expect(await getCardsForNode('rem')).toHaveLength(1);
  });

  it('soft-deletes rather than dropping rows, so sync can see the deletion', async () => {
    await remWith(textDoc('A :: B'));
    await deleteCardsForNode('rem');
    expect(await db.cards.count()).toBe(1);
    expect(await getCardsForNode('rem')).toHaveLength(0);
  });
});

describe('the review queue', () => {
  it('returns due cards oldest-due first and excludes suspended ones', async () => {
    const now = Date.now();
    await remWith(textDoc('A :: B'));
    await db.cards.update('rem::forward', { dueAt: now - 5 * DAY_MS });

    const other = await addTextNode('rem2', 'C :: D', { content: textDoc('C :: D') });
    await reconcileCards(other);
    await db.cards.update('rem2::forward', { dueAt: now - DAY_MS });

    const future = await addTextNode('rem3', 'E :: F', { content: textDoc('E :: F') });
    await reconcileCards(future);
    await db.cards.update('rem3::forward', { dueAt: now + DAY_MS });

    expect((await getDueCards(now)).map((c) => c.id)).toEqual(['rem::forward', 'rem2::forward']);

    await setCardSuspended('rem::forward', true);
    expect((await getDueCards(now)).map((c) => c.id)).toEqual(['rem2::forward']);
  });

  it('counts the overview stats the way the Flashcards tab reads them', async () => {
    const now = Date.now();
    await remWith(textDoc('A :: B'));
    await db.cards.update('rem::forward', { dueAt: now - DAY_MS });
    const other = await addTextNode('rem2', 'C :: D', { content: textDoc('C :: D') });
    await reconcileCards(other);
    await db.cards.update('rem2::forward', {
      interval: 30,
      lastReviewedAt: now - DAY_MS,
      dueAt: now + 10 * DAY_MS,
    });

    const stats = await getCardStats(now);
    expect(stats).toMatchObject({ total: 2, due: 1, fresh: 1, mature: 1, learning: 0 });
  });

  it('leaves tombstoned cards out of every read', async () => {
    await remWith(textDoc('A :: B'));
    await deleteCardsForNode('rem');
    expect(await getAllCards()).toHaveLength(0);
    expect(await getDueCards()).toHaveLength(0);
    expect((await getCardStats()).total).toBe(0);
  });
});

describe('grading', () => {
  it('reschedules the card and appends exactly one log row', async () => {
    await remWith(textDoc('A :: B'));
    const before = await db.cards.get('rem::forward');

    await gradeCard('rem::forward', 4);

    const after = await db.cards.get('rem::forward');
    const log = await getReviewsForCard('rem::forward');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      grade: 4,
      state: 'new',
      elapsedMs: null,
      intervalBefore: before?.interval,
      intervalAfter: after?.interval,
      easeBefore: before?.easeFactor,
      easeAfter: after?.easeFactor,
    });
    expect(after?.dueAt).toBeGreaterThan(before?.dueAt ?? 0);
  });

  it('records the state the card carried in, not the one it left with', async () => {
    await remWith(textDoc('A :: B'));
    await gradeCard('rem::forward', 4);
    // The log is ordered by `reviewedAt`, so two gradings inside the same
    // millisecond come back in an arbitrary order. That never happens with a
    // human pressing keys, but it happens constantly in a test.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await gradeCard('rem::forward', 0);
    const log = await getReviewsForCard('rem::forward');

    expect(log).toHaveLength(2);
    // The second review must see exactly what the first one left behind, or
    // the log cannot be replayed.
    expect(log[1]?.intervalBefore).toBe(log[0]?.intervalAfter);
    expect(log[1]?.easeBefore).toBe(log[0]?.easeAfter);
    expect(log[1]?.elapsedMs).toBeTypeOf('number');
  });

  it('does nothing at all for a card that no longer exists', async () => {
    await gradeCard('nope::forward', 4);
    expect(await db.reviews.count()).toBe(0);
  });

  it('suspending a card does not grade it', async () => {
    // The regression that made a card suspended in September come back in
    // March carrying an interval from a review that never happened.
    await remWith(textDoc('A :: B'));
    const before = await db.cards.get('rem::forward');

    await setCardSuspended('rem::forward', true);

    const after = await db.cards.get('rem::forward');
    expect(after?.suspended).toBe(true);
    expect(after?.dueAt).toBe(before?.dueAt);
    expect(after?.interval).toBe(before?.interval);
    expect(after?.repetitions).toBe(before?.repetitions);
    expect(await db.reviews.count()).toBe(0);
  });

  it('resetting a card clears its schedule but never its history', async () => {
    await remWith(textDoc('A :: B'));
    await gradeCard('rem::forward', 5);
    await resetCard('rem::forward');

    const card = await db.cards.get('rem::forward');
    expect(card).toMatchObject({ interval: 0, repetitions: 0, lapses: 0, lastReviewedAt: null });
    expect(card?.easeFactor).toBe(2.5);
    // Those reviews still happened. The log is append-only.
    expect(await getReviewsForCard('rem::forward')).toHaveLength(1);
  });
});

describe('building a session', () => {
  /** `n` rems, each with one `::` card, all due now. */
  async function dueCards(n: number) {
    for (let i = 0; i < n; i++) {
      const node = await addTextNode(`n${i}`, 'A :: B', { content: textDoc('A :: B') });
      await reconcileCards(node);
    }
  }

  it('applies the daily limit to what is actually due', async () => {
    await dueCards(5);
    const plan = await buildReviewQueue({ ...DEFAULT_SETTINGS, newPerDay: 2 });
    expect(plan.queue).toHaveLength(2);
    expect(plan.heldByLimit).toBe(3);
  });

  it('counts reviews already done today against the limit', async () => {
    await dueCards(4);
    await gradeCard('n0::forward', 4);
    await gradeCard('n1::forward', 4);

    expect(await getTodayCounts()).toEqual({ newSeen: 2, reviewsDone: 0 });

    // Two of the day's three new cards are spent, so one is left.
    const plan = await buildReviewQueue({ ...DEFAULT_SETTINGS, newPerDay: 3 });
    expect(plan.queue).toHaveLength(1);
  });

  it('buries siblings generated by the same rem', async () => {
    const node = await addTextNode('rem', 'cloze', { content: clozeDoc([1, 'a'], [2, 'b'], [3, 'c']) });
    await reconcileCards(node);
    expect(await getDueCards()).toHaveLength(3);

    const plan = await buildReviewQueue({ ...DEFAULT_SETTINGS, burySiblings: true });
    expect(plan.queue).toHaveLength(1);
    expect(plan.heldBySiblings).toBe(2);
  });

  it('builds a practice queue from cards that are nowhere near due', async () => {
    await dueCards(3);
    const far = Date.now() + 365 * DAY_MS;
    await db.cards.toCollection().modify({ dueAt: far });
    expect(await getDueCards()).toHaveLength(0);
    expect(await buildPracticeQueue()).toHaveLength(3);
  });

  it('finds the cards worth rewriting rather than re-reviewing', async () => {
    await dueCards(3);
    await db.cards.update('n0::forward', { lapses: 9 });
    await db.cards.update('n1::forward', { lapses: 12 });

    const leeches = await getLeeches(8);
    expect(leeches.map((c) => c.id)).toEqual(['n1::forward', 'n0::forward']);
    expect(await getLeeches(20)).toHaveLength(0);
    expect(await getLeeches(null)).toHaveLength(0);
  });
});
