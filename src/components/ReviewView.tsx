import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEditor, EditorContent } from '@tiptap/react';
import { readOnlyExtensions } from '../tiptap/extensions';
import { parseDoc, renderCloze, splitOnSeparator, type DocNode } from '../tiptap/docUtils';
import { getAllCards, getCardStats, getDueCards, gradeCard, resetCard, setCardSuspended } from '../db/cardRepository';
import { findRootPage, getNode } from '../db/repository';
import { GRADES, describeDue, previewInterval } from '../srs/sm2';
import type { Flashcard } from '../db/schema';

/** Renders a rem's document without any editing affordances — a card face. */
function RemDoc({ doc, className }: { doc: DocNode; className?: string }) {
  const serialized = JSON.stringify(doc);
  const editor = useEditor(
    { extensions: readOnlyExtensions, content: doc, editable: false },
    []
  );

  useEffect(() => {
    if (editor) editor.commands.setContent(JSON.parse(serialized), { emitUpdate: false });
  }, [editor, serialized]);

  return (
    <div className={className}>
      <EditorContent editor={editor} />
    </div>
  );
}

interface Faces {
  front: DocNode;
  back: DocNode;
}

/** Work out what to show on each side of a card, given its kind. */
function facesFor(card: Flashcard, content: string): Faces | null {
  const doc = parseDoc(content);

  if (card.kind === 'cloze') {
    const index = card.clozeIndex ?? 1;
    return { front: renderCloze(doc, index, false), back: renderCloze(doc, index, true) };
  }

  const sides = splitOnSeparator(doc);
  if (!sides) return null;
  return card.kind === 'backward' ? { front: sides.back, back: sides.front } : sides;
}

function kindLabel(card: Flashcard): string {
  if (card.kind === 'cloze') return `Cloze ${card.clozeIndex ?? 1}`;
  return card.kind === 'backward' ? 'Reverse' : 'Forward';
}

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

  const current = queue?.[0] ?? null;
  const node = useLiveQuery(
    () => (current ? getNode(current.nodeId) : Promise.resolve(undefined)),
    [current?.nodeId]
  );
  const page = useLiveQuery(
    () => (current ? findRootPage(current.nodeId) : Promise.resolve(undefined)),
    [current?.nodeId]
  );

  const faces = useMemo(
    () => (current && node ? facesFor(current, node.content) : null),
    [current, node?.content]
  );

  const startSession = useCallback(async () => {
    const due = await getDueCards();
    setQueue(due);
    setSessionSize(due.length);
    setReviewed(0);
    setRevealed(false);
  }, []);

  const answer = useCallback(
    async (quality: number) => {
      if (!current) return;
      await gradeCard(current.id, quality);
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
    [current]
  );

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
          <span className="review-kind">{kindLabel(current)}</span>
        </div>

        <div className="review-card">
          {page && (
            <button type="button" className="review-source" onClick={() => onZoomTo(current.nodeId)}>
              {page.plainText || 'Untitled'} ↗
            </button>
          )}

          {faces ? (
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
              This card's rem no longer has a <code>::</code> or a cloze in it.
              <button type="button" onClick={() => void answer(4)}>Skip</button>
            </div>
          )}
        </div>

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
                  <span className="review-grade-interval">{previewInterval(current, grade.quality)}</span>
                  <kbd>{grade.hotkey}</kbd>
                </button>
              ))}
            </div>
          )}
          <div className="review-meta">
            <button type="button" onClick={() => void setCardSuspended(current.id, true).then(() => answer(4))}>Suspend</button>
            <button type="button" onClick={() => void resetCard(current.id)}>Reset</button>
            <span>ease {current.easeFactor.toFixed(2)} · {current.lapses} lapse{current.lapses === 1 ? '' : 's'}</span>
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
        <h1>Session complete</h1>
        <p>{reviewed} card{reviewed === 1 ? '' : 's'} reviewed.</p>
        <div className="review-done-actions">
          <button type="button" className="primary-btn" onClick={() => void startSession()}>Check for more</button>
          <button type="button" className="ghost-btn" onClick={() => setQueue(null)}>Back to overview</button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- overview

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
          <code>{'{{curly braces}}'}</code> for a fill-in-the-blank. Scheduling uses SM-2 — the same
          algorithm behind SuperMemo and Anki.
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

      {stats && stats.due > 0 ? (
        <button type="button" className="primary-btn review-start" onClick={() => void startSession()}>
          Start review · {stats.due} card{stats.due === 1 ? '' : 's'}
        </button>
      ) : (
        <div className="review-empty">
          {stats && stats.total === 0 ? (
            <p>No cards yet. Add <code>::</code> to a rem and it will show up here.</p>
          ) : (
            <p>Nothing due right now. Next card {nextDue ? describeDue(nextDue) : 'soon'}.</p>
          )}
        </div>
      )}

      {suspended > 0 && (
        <p className="review-suspended-note">{suspended} card{suspended === 1 ? '' : 's'} suspended.</p>
      )}
    </div>
  );
}
