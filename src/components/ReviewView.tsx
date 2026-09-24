import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { parseDoc } from '../tiptap/docUtils';
import { facesFor, kindLabel } from '../tiptap/cardFaces';
import {
  buildPracticeQueue,
  buildReviewQueue,
  getAllCards,
  getCardStats,
  getLeeches,
  getPageCardCounts,
  gradeCard,
  resetCard,
  setCardSuspended,
} from '../db/cardRepository';
import { findRootPage, getChildren, getNode } from '../db/repository';
import { GRADES, describeDue, previewInterval } from '../srs/sm2';
import { historySince, previewFsrs, recallProbability, replay } from '../srs/fsrs';
import { fsrsOptions } from '../db/cardRepository';
import { getReviewsForCard } from '../db/reviewRepository';
import { isLeech } from '../srs/session';
import { loadSettings, saveSettings, type ReviewSettings } from '../srs/settings';
import { SessionSettings } from './SessionSettings';
import { ReadOnlyDoc as RemDoc } from './ReadOnlyDoc';
import { StatsPanel } from './StatsPanel';
import type { Flashcard } from '../db/schema';

interface ReviewViewProps {
  onZoomTo: (nodeId: string) => void;
}

export function ReviewView({ onZoomTo }: ReviewViewProps) {
  const stats = useLiveQuery(() => getCardStats(), []) ?? null;
  const allCards = useLiveQuery(() => getAllCards(), []) ?? [];

  /** null = not in a session; an array = the queue for the current session. */
  const [queue, setQueue] = useState<Flashcard[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [sessionSize, setSessionSize] = useState(0);
  /** Practice sessions read the queue and write nothing back. */
  const [practice, setPractice] = useState(false);
  const [settings, setSettings] = useState<ReviewSettings>(loadSettings);
  /** How many due cards the daily limits and sibling burying held back. */
  const [held, setHeld] = useState({ byLimit: 0, bySiblings: 0 });
  /** null = the whole collection; an id = only that document. */
  const [scope, setScope] = useState<string | null>(null);

  const pageCountsQuery = useLiveQuery(() => getPageCardCounts(), []);
  const pageCounts = pageCountsQuery ?? [];
  const scopedPage = scope ? pageCounts.find((p) => p.pageId === scope) : null;

  /**
   * A scope whose document has lost all its cards would silently review
   * nothing, so drop back to the whole collection.
   *
   * The effect depends on a boolean rather than on `pageCounts`: while the
   * query is pending, `?? []` is a fresh array every render, and an effect
   * keyed on that which also calls `setState` spins until Dexie answers.
   * `undefined` reads as "still true", so nothing happens until there is a
   * real answer.
   */
  const scopeStillExists = pageCountsQuery?.some((p) => p.pageId === scope) ?? true;
  useEffect(() => {
    if (scope && !scopeStillExists) setScope(null);
  }, [scope, scopeStillExists]);

  const leeches = useLiveQuery(() => getLeeches(settings.leechThreshold), [settings.leechThreshold]) ?? [];

  const updateSettings = useCallback((next: ReviewSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const current = queue?.[0] ?? null;
  const node = useLiveQuery(
    () => (current ? getNode(current.nodeId) : Promise.resolve(undefined)),
    [current?.nodeId]
  );
  const page = useLiveQuery(
    () => (current ? findRootPage(current.nodeId) : Promise.resolve(undefined)),
    [current?.nodeId]
  );

  // The answer to a list card (and to `A ::` with nothing after it) is the
  // rem's children, read live — edit the list and the card follows. The result
  // carries the id it was asked about: moving to the next card must not show
  // the previous card's list for a frame, and "not loaded yet" must not read
  // as "nothing underneath".
  const usesChildren = current !== null && current.kind !== 'cloze';
  const childrenQuery = useLiveQuery(
    async () =>
      current && usesChildren
        ? { forId: current.nodeId, rows: await getChildren(current.nodeId) }
        : { forId: current?.nodeId ?? null, rows: [] },
    [current?.nodeId, usesChildren]
  );
  const childrenReady = childrenQuery !== undefined && childrenQuery.forId === (current?.nodeId ?? null);

  // FSRS previews need the card's history; tagged with the card it belongs to
  // for the same reason as the children above.
  const historyQuery = useLiveQuery(
    async () => (current ? { forId: current.id, rows: await getReviewsForCard(current.id) } : null),
    [current?.id]
  );
  const history =
    current && historyQuery && historyQuery.forId === current.id ? historySince(current, historyQuery.rows) : null;
  const useFsrs = settings.scheduler === 'fsrs';
  const memory = useFsrs && history ? replay(history, fsrsOptions(settings)) : null;
  const recall = memory ? recallProbability(memory, undefined, fsrsOptions(settings)) : null;
  const intervalLabel = (quality: number) =>
    !current
      ? ''
      : useFsrs
        ? history
          ? previewFsrs(current, history, quality, undefined, fsrsOptions(settings))
          : '…'
        : previewInterval(current, quality);
  // Same trap for the rem itself: the previous card's rem answers first.
  const nodeReady = node !== undefined && node.id === current?.nodeId;

  // Not memoised: `RemDoc` compares the serialised doc before re-rendering,
  // and parsing a card's worth of JSON is cheaper than keeping a memo honest
  // over a live query that returns a fresh array on every change.
  const faces =
    current && node && nodeReady && childrenReady
      ? facesFor(
          current,
          node.content,
          childrenQuery.rows.filter((c) => !c.isPortal).map((c) => parseDoc(c.content))
        )
      : null;

  const startSession = useCallback(async () => {
    const plan = await buildReviewQueue(settings, Date.now(), scope);
    setPractice(false);
    setQueue(plan.queue);
    setSessionSize(plan.queue.length);
    setHeld({ byLimit: plan.heldByLimit, bySiblings: plan.heldBySiblings });
    setReviewed(0);
    setRevealed(false);
  }, [settings, scope]);

  const startPractice = useCallback(async () => {
    const cards = await buildPracticeQueue(40, scope);
    setPractice(true);
    setQueue(cards);
    setSessionSize(cards.length);
    setHeld({ byLimit: 0, bySiblings: 0 });
    setReviewed(0);
    setRevealed(false);
  }, [scope]);

  const answer = useCallback(
    async (quality: number) => {
      if (!current) return;
      // Practice writes nothing: no reschedule, no log row. Drilling before an
      // exam should not cost you the spacing you have built up.
      if (!practice) await gradeCard(current.id, quality, settings);
      setReviewed((n) => n + 1);
      setRevealed(false);
      setQueue((q) => {
        if (!q) return q;
        const [head, ...rest] = q;
        // A forgotten card comes back at the end of this same session rather
        // than waiting ten minutes of wall-clock time to reappear.
        return quality < 3 && head ? [...rest, head] : rest;
      });
    },
    [current, practice, settings]
  );

  /**
   * Drop the current card out of the session without touching its scheduling.
   *
   * This is deliberately *not* `answer(...)`: suspending or skipping a card is
   * a statement about the queue, not about how well you remembered it. Routing
   * it through `answer` (as Suspend used to) recorded a review that never
   * happened, so a card suspended today and unsuspended in March came back
   * carrying an interval it was never actually graded into.
   *
   * The session size shrinks with the card so the progress bar keeps meaning
   * "cards answered out of cards to answer".
   */
  const skip = useCallback(() => {
    if (!current) return;
    setRevealed(false);
    setQueue((q) => (q ? q.slice(1) : q));
    setSessionSize((n) => Math.max(reviewed, n - 1));
  }, [current, reviewed]);

  // Space/Enter reveals; 1–4 grade. Only while a card is on screen.
  useEffect(() => {
    if (!current) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) return;

      if (!revealed && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        setRevealed(true);
        return;
      }
      if (revealed) {
        const grade = GRADES.find((g) => g.hotkey === event.key);
        if (grade) {
          event.preventDefault();
          void answer(grade.quality);
        }
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          void answer(4);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, revealed, answer]);

  // ---------------------------------------------------------------- session

  if (queue !== null && current) {
    const progress = sessionSize > 0 ? Math.min(100, (reviewed / sessionSize) * 100) : 0;

    return (
      <div className="review">
        <div className="review-topbar">
          <button type="button" className="review-exit" onClick={() => setQueue(null)}>← End session</button>
          <div className="review-progress">
            <div className="review-progress-bar"><span style={{ width: `${progress}%` }} /></div>
            <span className="review-progress-text">{reviewed} / {sessionSize}</span>
          </div>
          <span className="review-kinds">
            {practice && <span className="review-practice-tag">Practice</span>}
            <span className="review-kind">{kindLabel(current)}</span>
          </span>
        </div>

        <div className="review-card">
          {page && (
            <button type="button" className="review-source" onClick={() => onZoomTo(current.nodeId)}>
              {page.plainText || 'Untitled'} ↗
            </button>
          )}

          {!childrenReady || !nodeReady ? (
            <div className="review-face review-front" />
          ) : faces ? (
            <>
              <RemDoc doc={faces.front} className="review-face review-front" />
              {revealed && (
                <>
                  <div className="review-rule" />
                  <RemDoc doc={faces.back} className="review-face review-back" />
                </>
              )}
            </>
          ) : (
            <div className="review-broken">
              This card's rem no longer has the <code>::</code>, <code>&gt;&gt;&gt;</code> or cloze
              that made it.
              <button type="button" onClick={skip}>Skip</button>
              <button
                type="button"
                onClick={() => void setCardSuspended(current.id, true).then(skip)}
              >
                Suspend it
              </button>
            </div>
          )}
        </div>

        {isLeech(current, settings.leechThreshold) && (
          <div className="review-leech">
            <strong>You have forgotten this {current.lapses} times.</strong>
            <span>
              That is usually the card, not you — two ideas in one blank, or an answer that could
              be three other things. Rewriting the rem beats reviewing it again.
            </span>
            <div className="review-leech-actions">
              <button type="button" onClick={() => onZoomTo(current.nodeId)}>Rewrite it</button>
              <button type="button" onClick={() => void setCardSuspended(current.id, true).then(skip)}>
                Suspend for now
              </button>
            </div>
          </div>
        )}

        <div className="review-controls">
          {!revealed ? (
            <button type="button" className="review-reveal" onClick={() => setRevealed(true)}>
              Show answer <kbd>Space</kbd>
            </button>
          ) : (
            <div className="review-grades">
              {GRADES.map((grade) => (
                <button
                  key={grade.key}
                  type="button"
                  className={`review-grade review-grade-${grade.key}`}
                  onClick={() => void answer(grade.quality)}
                >
                  <span className="review-grade-label">{grade.label}</span>
                  <span className="review-grade-interval">{intervalLabel(grade.quality)}</span>
                  <kbd>{grade.hotkey}</kbd>
                </button>
              ))}
            </div>
          )}
          <div className="review-meta">
            <button type="button" onClick={() => void setCardSuspended(current.id, true).then(skip)}>Suspend</button>
            <button type="button" onClick={() => void resetCard(current.id)}>Reset</button>
            <span>
              {memory?.state
                ? `stability ${Math.round(memory.state.stability)}d · difficulty ${memory.state.difficulty.toFixed(1)}`
                : useFsrs
                  ? 'new card'
                  : `ease ${current.easeFactor.toFixed(2)}`}
              {recall !== null && ` · ${Math.round(recall * 100)}% recall now`}
              {' · '}
              {current.lapses} lapse{current.lapses === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------- session just finished

  if (queue !== null && !current) {
    return (
      <div className="review review-done">
        <div className="review-done-mark">✓</div>
        <h1>{practice ? 'Practice finished' : 'Session complete'}</h1>
        <p>
          {reviewed} card{reviewed === 1 ? '' : 's'} {practice ? 'practised' : 'reviewed'}.
          {practice && ' Nothing was recorded — every schedule is exactly where you left it.'}
        </p>
        {!practice && (held.byLimit > 0 || held.bySiblings > 0) && (
          <p className="review-done-held">
            {held.byLimit > 0 && `${held.byLimit} more due today, held back by your daily limit. `}
            {held.bySiblings > 0 && `${held.bySiblings} sibling card${held.bySiblings === 1 ? '' : 's'} kept for another day.`}
          </p>
        )}
        <div className="review-done-actions">
          <button type="button" className="primary-btn" onClick={() => void startSession()}>Check for more</button>
          <button type="button" className="ghost-btn" onClick={() => setQueue(null)}>Back to overview</button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- overview

  // What "due" means depends on the scope the picker is set to.
  const dueInScope = scopedPage ? scopedPage.due : stats?.due ?? 0;

  const nextDue = allCards
    .filter((c) => !c.suspended)
    .map((c) => c.dueAt)
    .sort((a, b) => a - b)[0];
  const suspended = allCards.filter((c) => c.suspended).length;

  return (
    <div className="review review-overview">
      <header className="review-header">
        <h1>Flashcards</h1>
        <p>
          Write <code>Concept :: Descriptor</code> in any rem to make a card, or wrap words in{' '}
          <code>{'{{curly braces}}'}</code> for a fill-in-the-blank. End a rem with{' '}
          <code>&gt;&gt;&gt;</code> to be asked for everything underneath it, or with <code>::</code>{' '}
          to make its children the answer.{' '}
          {settings.scheduler === 'fsrs'
            ? `Scheduling uses FSRS, aiming for ${Math.round(settings.desiredRetention * 100)}% recall.`
            : 'Scheduling uses SM-2, the algorithm behind SuperMemo and classic Anki.'}
        </p>
      </header>

      {stats && (
        <div className="review-stats">
          <div className="review-stat review-stat-due">
            <span className="review-stat-value">{stats.due}</span>
            <span className="review-stat-label">due now</span>
          </div>
          <div className="review-stat">
            <span className="review-stat-value">{stats.fresh}</span>
            <span className="review-stat-label">new</span>
          </div>
          <div className="review-stat">
            <span className="review-stat-value">{stats.learning}</span>
            <span className="review-stat-label">learning</span>
          </div>
          <div className="review-stat">
            <span className="review-stat-value">{stats.mature}</span>
            <span className="review-stat-label">mature</span>
          </div>
          <div className="review-stat">
            <span className="review-stat-value">{stats.total}</span>
            <span className="review-stat-label">total</span>
          </div>
        </div>
      )}

      {pageCounts.length > 1 && (
        <div className="review-scope">
          <label htmlFor="review-scope">Review</label>
          <select
            id="review-scope"
            value={scope ?? ''}
            onChange={(event) => setScope(event.target.value || null)}
          >
            <option value="">Everything · {stats?.due ?? 0} due</option>
            {pageCounts.map((page) => (
              <option key={page.pageId} value={page.pageId}>
                {page.title} · {page.due} due of {page.total}
              </option>
            ))}
          </select>
        </div>
      )}

      {dueInScope > 0 ? (
        <div className="review-actions">
          <button type="button" className="primary-btn review-start" onClick={() => void startSession()}>
            Start review · {dueInScope} card{dueInScope === 1 ? '' : 's'}
            {scopedPage ? ` from ${scopedPage.title}` : ''}
          </button>
          <button type="button" className="ghost-btn" onClick={() => void startPractice()}>
            Practice instead
          </button>
        </div>
      ) : (
        <div className="review-empty">
          {stats && stats.total === 0 ? (
            <p>No cards yet. Add <code>::</code> to a rem and it will show up here.</p>
          ) : scopedPage ? (
            <>
              <p>
                Nothing due in {scopedPage.title} — {scopedPage.total} card
                {scopedPage.total === 1 ? '' : 's'} there, all scheduled ahead.
              </p>
              <button type="button" className="ghost-btn" onClick={() => void startPractice()}>
                Practise it anyway
              </button>
            </>
          ) : (
            <>
              <p>Nothing due right now. Next card {nextDue ? describeDue(nextDue) : 'soon'}.</p>
              <button type="button" className="ghost-btn" onClick={() => void startPractice()}>
                Practice anyway
              </button>
            </>
          )}
        </div>
      )}

      {leeches.length > 0 && (
        <div className="review-leeches">
          <h2>{leeches.length} card{leeches.length === 1 ? '' : 's'} you keep forgetting</h2>
          <p>
            Failed {settings.leechThreshold} times or more. These are almost always worth
            rewriting rather than reviewing again.
          </p>
          <ul>
            {leeches.slice(0, 8).map((card) => (
              <li key={card.id}>
                <button type="button" onClick={() => onZoomTo(card.nodeId)}>
                  {kindLabel(card)} · {card.lapses} lapses
                </button>
                <button
                  type="button"
                  className="review-leech-suspend"
                  onClick={() => void setCardSuspended(card.id, true)}
                >
                  Suspend
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <SessionSettings settings={settings} onChange={updateSettings} />

      {suspended > 0 && (
        <p className="review-suspended-note">{suspended} card{suspended === 1 ? '' : 's'} suspended.</p>
      )}

      <StatsPanel />
    </div>
  );
}
