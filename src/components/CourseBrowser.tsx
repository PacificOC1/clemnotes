import { useEffect, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CATALOGUE, unitsLabel, type CatalogueSubject } from '../courses/catalogue';
import {
  isStudied,
  type AreaProgress,
  type ChapterProgress,
  type SectionProgress,
  type TextbookProgress,
  type GroupProgress,
  type PointProgress,
  type PointStatus,
  type Roadmap,
  type Tally,
  type UnitProgress,
} from '../courses/courseTree';
import { hasPack, hasTextbook, loadPackTitles, loadTextbook } from '../courses/packs';
import { sectionHeading, type TextbookChapterEntry } from '../courses/textbook';
import { pointKey } from '../courses/notesPack';
import { deriveTitle } from '../courses/titles';
import {
  addStudyNotes,
  addTextbookNotes,
  loadLesson,
  loadRoadmap,
  type LessonRem,
  type StudyNotesResult,
  type TextbookNotesResult,
} from '../db/courseRepository';
import { extractClozeIndices, parseDoc, splitOnSeparator, type DocNode } from '../tiptap/docUtils';
import { ReadOnlyDoc } from './ReadOnlyDoc';

/**
 * A course, browsed level by level: the subject → its units (with their
 * introductions) → a unit's areas of study → an area's learning points → one
 * learning point as a lesson. Each level is its own screen with its own URL
 * (`#/courses/<course>/<item>`), laid out as a timeline, and the lesson shows
 * the notes as reading material rather than as the outline they're stored in.
 */

export interface CourseBrowserProps {
  pageId: string;
  /** The unit, area, skills section or learning point open; null = the course overview. */
  item: string | null;
  onOpen: (item: string | null) => void;
  onBackToCourses: () => void;
  onStudy: (scope: string) => void;
  onZoomTo: (nodeId: string) => void;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<PointStatus, string> = {
  todo: 'Not started',
  notes: 'Your notes',
  cards: 'Cards to learn',
  learning: 'Learning',
  mastered: 'Mastered',
};

export function ProgressBar({ tally }: { tally: Tally }) {
  const pct = (n: number) => (tally.points ? (n / tally.points) * 100 : 0);
  // `studied` includes notes-only points (no cards), so split them out first.
  const notesOnly = tally.started - tally.withCards;
  const learning = tally.studied - tally.mastered - notesOnly;
  const toLearn = tally.withCards - learning - tally.mastered;
  return (
    <div
      className="course-bar"
      role="img"
      aria-label={`${tally.mastered} mastered, ${learning} learning, ${toLearn} with cards to learn, ${notesOnly} with notes only, ${tally.points - tally.started} not started`}
    >
      <span className="course-bar-mastered" style={{ width: `${pct(tally.mastered)}%` }} />
      <span className="course-bar-learning" style={{ width: `${pct(learning)}%` }} />
      <span className="course-bar-notes" style={{ width: `${pct(notesOnly)}%` }} />
      <span className="course-bar-cards" style={{ width: `${pct(toLearn)}%` }} />
    </div>
  );
}

/** A ring showing how much is studied (and mastered, on top), with a label in the middle. */
function Ring({ tally, label, locked = false }: { tally?: Tally; label: string; locked?: boolean }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  const studied = tally && tally.points ? tally.studied / tally.points : 0;
  const mastered = tally && tally.points ? tally.mastered / tally.points : 0;
  const done = tally !== undefined && tally.points > 0 && tally.mastered === tally.points;
  return (
    <svg className={`tl-ring ${locked ? 'is-locked' : ''} ${done ? 'is-done' : ''}`} viewBox="0 0 42 42" aria-hidden="true">
      <circle className="tl-ring-bg" cx="21" cy="21" r={r} />
      {/* Only when there's an arc to draw: a zero-length dash with round caps is still a dot. */}
      {!locked && studied > 0 && <circle className="tl-ring-studied" cx="21" cy="21" r={r} strokeDasharray={`${studied * c} ${c}`} />}
      {!locked && mastered > 0 && <circle className="tl-ring-mastered" cx="21" cy="21" r={r} strokeDasharray={`${mastered * c} ${c}`} />}
      <text x="21" y="21" dominantBaseline="central" textAnchor="middle">
        {done ? '✓' : label}
      </text>
    </svg>
  );
}

function StatusIcon({ status }: { status: PointStatus }) {
  return <span className={`status-icon status-${status}`} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />;
}

function tallyLine(t: Tally): string {
  const parts = [`${t.studied}/${t.points} studied`];
  if (t.cards > 0) parts.push(`${t.cards} card${t.cards === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function DueNew({ t }: { t: Pick<Tally, 'due' | 'fresh'> }) {
  const reviews = t.due - t.fresh;
  return (
    <>
      {reviews > 0 && <span className="course-due"> · {reviews} to review</span>}
      {t.fresh > 0 && <span> · {t.fresh} new</span>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/**
 * Short titles, with the study design's own wording kept as a subtitle:
 * catalogue names for units and areas, study-notes labels for learning
 * points, and a title cut from the wording for anything else.
 */
interface Titles {
  unit: (u: UnitProgress) => string;
  area: (u: UnitProgress, a: AreaProgress) => string;
  /** The question itself, when a short name is shown instead of it. */
  unitQuestion: (u: UnitProgress) => string | null;
  areaQuestion: (u: UnitProgress, a: AreaProgress) => string | null;
  point: (p: PointProgress) => string;
}

function useTitles(subject: CatalogueSubject | undefined): Titles {
  const [labels, setLabels] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    let live = true;
    if (subject && hasPack(subject.id)) {
      void loadPackTitles(subject.id).then((m) => {
        if (live) setLabels(m);
      });
    }
    return () => {
      live = false;
    };
  }, [subject]);
  const names = subject?.shortNames ?? {};
  return {
    unit: (u) => names[`U${u.number}`] ?? u.title,
    area: (u, a) => names[`U${u.number}.${a.number}`] ?? a.title,
    unitQuestion: (u) => (names[`U${u.number}`] ? u.title : null),
    areaQuestion: (u, a) => (names[`U${u.number}.${a.number}`] ? a.title : null),
    point: (p) => labels?.get(pointKey(p.text)) ?? deriveTitle(p.text),
  };
}

// ---------------------------------------------------------------------------
// Finding where we are
// ---------------------------------------------------------------------------

type Place =
  | { kind: 'overview' }
  | { kind: 'unit'; unit: UnitProgress }
  | { kind: 'area'; unit: UnitProgress; area: AreaProgress }
  | { kind: 'skills'; skills: NonNullable<Roadmap['skills']> }
  | { kind: 'point'; point: PointProgress; group: GroupProgress; unit: UnitProgress | null; area: AreaProgress | null }
  | { kind: 'textbook'; book: TextbookProgress }
  | { kind: 'chapter'; book: TextbookProgress; chapter: ChapterProgress }
  | { kind: 'section'; book: TextbookProgress; chapter: ChapterProgress; section: SectionProgress };

function locate(roadmap: Roadmap, item: string | null): Place {
  if (!item) return { kind: 'overview' };
  if (roadmap.skills?.id === item) return { kind: 'skills', skills: roadmap.skills };
  for (const unit of roadmap.units) {
    if (unit.id === item) return { kind: 'unit', unit };
    for (const area of unit.areas) {
      if (area.id === item) return { kind: 'area', unit, area };
      for (const group of area.groups) {
        const point = group.points.find((p) => p.id === item);
        if (point) return { kind: 'point', point, group, unit, area };
      }
    }
  }
  for (const group of roadmap.skills?.groups ?? []) {
    const point = group.points.find((p) => p.id === item);
    if (point) return { kind: 'point', point, group, unit: null, area: null };
  }
  const book = roadmap.textbook;
  if (book) {
    if (book.id === item) return { kind: 'textbook', book };
    for (const chapter of book.chapters) {
      if (chapter.id === item) return { kind: 'chapter', book, chapter };
      const section = chapter.sections.find((s) => s.id === item);
      if (section) return { kind: 'section', book, chapter, section };
    }
  }
  return { kind: 'overview' };
}

/** Study-design position ("U2.2.1.1", "S.1.2") of every learning point, as packs number them. */
function positionsOf(roadmap: Roadmap): Map<string, PointProgress> {
  const out = new Map<string, PointProgress>();
  for (const unit of roadmap.units) {
    for (const area of unit.areas) {
      area.groups.forEach((g, gi) => g.points.forEach((p, pi) => out.set(`U${unit.number}.${area.number}.${gi + 1}.${pi + 1}`, p)));
    }
  }
  roadmap.skills?.groups.forEach((g, gi) => g.points.forEach((p, pi) => out.set(`S.${gi + 1}.${pi + 1}`, p)));
  return out;
}

/** The subject's textbook pack (which section covers which learning points), loaded once. */
function useTextbookPack(subject: CatalogueSubject | undefined): TextbookChapterEntry[] | null {
  const [chapters, setChapters] = useState<TextbookChapterEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    if (subject && hasTextbook(subject.id)) {
      void loadTextbook(subject.id).then((c) => {
        if (live) setChapters(c);
      });
    }
    return () => {
      live = false;
    };
  }, [subject]);
  return chapters;
}

/** Section number → the learning points it covers, and point id → the sections that cover it. */
function textbookLinks(roadmap: Roadmap, pack: TextbookChapterEntry[] | null) {
  const byPosition = positionsOf(roadmap);
  const pointsOf = new Map<string, PointProgress[]>();
  const sectionsOf = new Map<string, SectionProgress[]>();
  const present = new Map((roadmap.textbook?.chapters ?? []).flatMap((c) => c.sections.map((s) => [s.number, s] as const)));
  for (const chapter of pack ?? []) {
    for (const entry of chapter.sections) {
      const points = entry.covers.map((pos) => byPosition.get(pos)).filter((p): p is PointProgress => p !== undefined);
      pointsOf.set(entry.number, points);
      const section = present.get(entry.number);
      if (!section) continue;
      for (const p of points) sectionsOf.set(p.id, [...(sectionsOf.get(p.id) ?? []), section]);
    }
  }
  return { pointsOf, sectionsOf };
}

/** Every learning point in order — key knowledge, then separately the skills — for previous/next. */
function sequenceFor(roadmap: Roadmap, inSkills: boolean): PointProgress[] {
  if (inSkills) return roadmap.skills?.groups.flatMap((g) => g.points) ?? [];
  return roadmap.units.flatMap((u) => u.areas.flatMap((a) => a.groups.flatMap((g) => g.points)));
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

export function CourseBrowser({ pageId, item, onOpen, onBackToCourses, onStudy, onZoomTo }: CourseBrowserProps) {
  const roadmap = useLiveQuery(() => loadRoadmap(pageId), [pageId]);
  const roadmapTitle = roadmap?.title.toLowerCase();
  const subject = CATALOGUE.find((s) => s.title.toLowerCase() === roadmapTitle);
  const titles = useTitles(subject);
  const textbookPack = useTextbookPack(subject);

  // A new level starts at its top, not wherever the last one was scrolled to.
  useEffect(() => {
    document.querySelector('.content')?.scrollTo({ top: 0 });
  }, [item]);

  if (roadmap === undefined) return <div className="view-loading">Loading…</div>;
  if (roadmap === null) {
    return (
      <div className="courses">
        <button type="button" className="link-btn courses-back" onClick={onBackToCourses}>
          ← Courses
        </button>
        <p className="subject-dim">This course isn't in your notes any more.</p>
      </div>
    );
  }

  const place = locate(roadmap, item);
  const crumbs: Array<{ label: string; to: string | null | 'courses' }> = [{ label: 'Courses', to: 'courses' }];
  if (place.kind !== 'overview') crumbs.push({ label: roadmap.title, to: null });
  if (place.kind === 'area' || (place.kind === 'point' && place.unit)) {
    const unit = place.kind === 'area' ? place.unit : place.unit!;
    crumbs.push({ label: `Unit ${unit.number}`, to: unit.id });
  }
  if (place.kind === 'point' && place.area) crumbs.push({ label: `Area of Study ${place.area.number}`, to: place.area.id });
  if (place.kind === 'point' && !place.area && roadmap.skills) crumbs.push({ label: 'Key science skills', to: roadmap.skills.id });
  if (place.kind === 'chapter' || place.kind === 'section') crumbs.push({ label: 'Textbook', to: place.book.id });
  if (place.kind === 'section') crumbs.push({ label: `Chapter ${place.chapter.number}`, to: place.chapter.id });
  const links = textbookLinks(roadmap, textbookPack);

  return (
    <div className={`courses course-browser course-${place.kind}`}>
      <nav className="course-crumbs" aria-label="Where you are">
        {crumbs.map((c, i) => (
          <span key={i}>
            {i > 0 && <span className="course-crumb-sep">›</span>}
            <button
              type="button"
              className="link-btn"
              onClick={() => (c.to === 'courses' ? onBackToCourses() : onOpen(c.to))}
            >
              {c.label}
            </button>
          </span>
        ))}
      </nav>

      {place.kind === 'overview' && (
        <CourseOverview
          roadmap={roadmap}
          pageId={pageId}
          titles={titles}
          textbookPack={textbookPack}
          onOpen={onOpen}
          onStudy={onStudy}
          onZoomTo={onZoomTo}
        />
      )}
      {place.kind === 'unit' && <UnitView unit={place.unit} titles={titles} onOpen={onOpen} onStudy={onStudy} />}
      {place.kind === 'area' && (
        <AreaView unit={place.unit} area={place.area} titles={titles} onOpen={onOpen} onStudy={onStudy} />
      )}
      {place.kind === 'skills' && <SkillsView skills={place.skills} titles={titles} onOpen={onOpen} onStudy={onStudy} />}
      {place.kind === 'point' && (
        <LessonView
          key={place.point.id}
          place={place}
          titles={titles}
          sequence={sequenceFor(roadmap, place.unit === null)}
          inTextbook={links.sectionsOf.get(place.point.id) ?? []}
          onOpen={onOpen}
          onStudy={onStudy}
          onZoomTo={onZoomTo}
        />
      )}
      {place.kind === 'textbook' && <TextbookView book={place.book} onOpen={onOpen} onStudy={onStudy} />}
      {place.kind === 'chapter' && <ChapterView chapter={place.chapter} onOpen={onOpen} onStudy={onStudy} />}
      {place.kind === 'section' && (
        <SectionView
          key={place.section.id}
          place={place}
          covers={links.pointsOf.get(place.section.number) ?? []}
          titles={titles}
          onOpen={onOpen}
          onStudy={onStudy}
          onZoomTo={onZoomTo}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Level 1 — the course: its units
// ---------------------------------------------------------------------------

function CourseOverview({
  roadmap,
  pageId,
  titles,
  textbookPack,
  onOpen,
  onStudy,
  onZoomTo,
}: {
  roadmap: Roadmap;
  pageId: string;
  titles: Titles;
  textbookPack: TextbookChapterEntry[] | null;
  onOpen: (item: string | null) => void;
  onStudy: (scope: string) => void;
  onZoomTo: (nodeId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<StudyNotesResult | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const subject = CATALOGUE.find((s) => s.title.toLowerCase() === roadmap.title.toLowerCase());
  const allPoints = roadmap.units.flatMap((u) => u.areas.flatMap((a) => a.groups.flatMap((g) => g.points)));
  const emptyPoints = allPoints.filter((p) => p.notes === 0 && p.cards === 0).length;
  const canAddNotes = subject !== undefined && hasPack(subject.id) && emptyPoints > 0;

  const [addingBook, setAddingBook] = useState(false);
  const [addedBook, setAddedBook] = useState<TextbookNotesResult | null>(null);
  const inBook = new Set((roadmap.textbook?.chapters ?? []).flatMap((c) => c.sections.map((s) => s.number)));
  const bookMissing = (textbookPack ?? []).reduce((n, c) => n + c.sections.filter((s) => !inBook.has(s.number)).length, 0);
  const canAddBook = subject?.textbook !== undefined && bookMissing > 0;

  async function fillTextbook() {
    if (!subject) return;
    setAddingBook(true);
    setAddError(null);
    try {
      setAddedBook(await addTextbookNotes(pageId, subject));
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingBook(false);
    }
  }

  async function fillNotes() {
    if (!subject) return;
    setAdding(true);
    setAddError(null);
    try {
      setAdded(await addStudyNotes(pageId, subject));
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  const { tally } = roadmap;
  const pct = tally.points ? Math.round((tally.studied / tally.points) * 100) : 0;

  return (
    <>
      <header className="course-head">
        <div className="course-head-text">
          <span className="course-kicker">{subject ? `${subject.curriculum} · ${unitsLabel(subject.units)}` : 'Course'}</span>
          <h1>{roadmap.title}</h1>
          {subject && <p className="subject-dim">Study design {subject.accredited}</p>}
        </div>
        <div className="course-head-actions">
          {canAddNotes && (
            <button
              type="button"
              className="ghost-btn"
              disabled={adding}
              onClick={() => void fillNotes()}
              title="Explanations, worked examples, common mistakes and flashcards for every learning point you haven't written notes for yet"
            >
              {adding ? 'Adding notes…' : 'Add study notes'}
            </button>
          )}
          {canAddBook && (
            <button
              type="button"
              className="ghost-btn"
              disabled={addingBook}
              onClick={() => void fillTextbook()}
              title={`Notes and flashcards that follow ${subject!.textbook!.title}, section by section`}
            >
              {addingBook ? 'Adding textbook notes…' : roadmap.textbook ? `Add ${bookMissing} textbook sections` : 'Add textbook notes'}
            </button>
          )}
          <button
            type="button"
            className="primary-btn"
            disabled={tally.cards === 0}
            onClick={() => onStudy(pageId)}
            title={tally.cards === 0 ? 'No flashcards in this course yet' : 'Flashcards from the whole course'}
          >
            {tally.due > 0 ? `Study · ${tally.due} due` : 'Study'}
          </button>
        </div>
      </header>

      {added && (
        <p className="roadmap-added" role="status">
          Added notes and flashcards to {added.added} learning point{added.added === 1 ? '' : 's'}.
          {added.skipped > 0 && ` ${added.skipped} already had your own notes, so they were left alone.`}
          {added.unmatched > 0 && ` ${added.unmatched} didn't match a learning point in this course.`} Undo with ⌘Z / Ctrl+Z.
        </p>
      )}
      {addedBook && (
        <p className="roadmap-added" role="status">
          Added {addedBook.added} textbook section{addedBook.added === 1 ? '' : 's'} — open <strong>Textbook</strong> below. Undo with ⌘Z /
          Ctrl+Z.
        </p>
      )}
      {addError && <p className="import-error">{addError}</p>}

      <div className="course-summary">
        <div className="course-summary-figures">
          <div>
            <span className="roadmap-figure">{pct}%</span>
            <span className="roadmap-figure-label">studied</span>
          </div>
          <div>
            <span className="roadmap-figure">
              {tally.studied}
              <small>/{tally.points}</small>
            </span>
            <span className="roadmap-figure-label">learning points</span>
          </div>
          <div>
            <span className="roadmap-figure">{tally.cards}</span>
            <span className="roadmap-figure-label">flashcards</span>
          </div>
          <div>
            <span className="roadmap-figure">{tally.mastered}</span>
            <span className="roadmap-figure-label">mastered</span>
          </div>
        </div>
        <ProgressBar tally={tally} />
      </div>

      {roadmap.next && (
        <button type="button" className="course-next" onClick={() => onOpen(roadmap.next!.point.id)}>
          <span className="course-next-label">
            Continue · Unit {roadmap.next.unit.number} · {titles.area(roadmap.next.unit, roadmap.next.area)}
          </span>
          <span className="course-next-text">{titles.point(roadmap.next.point)}</span>
          <span className="course-next-go" aria-hidden="true">
            →
          </span>
        </button>
      )}

      {roadmap.units.length === 0 && (
        <p className="subject-dim">
          No units found in this course. It needs headings like “Unit 1: …” with “Area of Study 1: …” under them —{' '}
          <button type="button" className="link-btn" onClick={() => onZoomTo(pageId)}>
            open its page
          </button>
          .
        </p>
      )}

      <ol className="tl">
        {roadmap.units.map((unit) => (
          <li key={unit.id} className="tl-item">
            <Ring tally={unit.tally} label={String(unit.number)} />
            <button type="button" className="tl-card" onClick={() => onOpen(unit.id)}>
              <span className="tl-kicker">Unit {unit.number}</span>
              <span className="tl-title">{titles.unit(unit)}</span>
              {titles.unitQuestion(unit) && <span className="tl-question">{titles.unitQuestion(unit)}</span>}
              {unit.description[0] && <span className="tl-desc">{unit.description[0]}</span>}
              <span className="tl-meta">
                {unit.areas.length} areas of study · {tallyLine(unit.tally)}
                <DueNew t={unit.tally} />
              </span>
            </button>
          </li>
        ))}
        {subject && subject.laterUnits.length > 0 && (
          <li className="tl-item tl-locked">
            <Ring label="…" locked />
            <div className="tl-card">
              <span className="tl-kicker">{unitsLabel(subject.laterUnits)}</span>
              <span className="tl-title">Coming later</span>
              <span className="tl-desc">The study design has them — the importer doesn't bring them in yet.</span>
            </div>
          </li>
        )}
      </ol>

      {roadmap.textbook && (
        <>
          <h2 className="course-section-title">By textbook chapter</h2>
          <ol className="tl tl-single">
            <li className="tl-item">
              <Ring tally={roadmap.textbook.tally} label="❡" />
              <button type="button" className="tl-card tl-card-textbook" onClick={() => onOpen(roadmap.textbook!.id)}>
                <span className="tl-kicker">Textbook</span>
                <span className="tl-title">{roadmap.textbook.title}</span>
                <span className="tl-desc">
                  {roadmap.textbook.chapters.map((c) => `Chapter ${c.number}: ${c.title}`).join(' · ') || 'No chapters yet.'}
                </span>
                <span className="tl-meta">
                  {roadmap.textbook.tally.points} section{roadmap.textbook.tally.points === 1 ? '' : 's'} · {tallyLine(roadmap.textbook.tally)}
                  <DueNew t={roadmap.textbook.tally} />
                </span>
              </button>
            </li>
          </ol>
        </>
      )}

      {roadmap.skills && roadmap.skills.tally.points > 0 && (
        <>
          <h2 className="course-section-title">Across every unit</h2>
          <ol className="tl tl-single">
            <li className="tl-item">
              <Ring tally={roadmap.skills.tally} label="✦" />
              <button type="button" className="tl-card" onClick={() => onOpen(roadmap.skills!.id)}>
                <span className="tl-kicker">Skills</span>
                <span className="tl-title">Key science skills</span>
                <span className="tl-desc">Investigation, data and communication skills used in every area of study.</span>
                <span className="tl-meta">
                  {tallyLine(roadmap.skills.tally)}
                  <DueNew t={roadmap.skills.tally} />
                </span>
              </button>
            </li>
          </ol>
        </>
      )}

      <Legend />
    </>
  );
}

// ---------------------------------------------------------------------------
// Level 2 — a unit: its areas of study
// ---------------------------------------------------------------------------

function UnitView({
  unit,
  titles,
  onOpen,
  onStudy,
}: {
  unit: UnitProgress;
  titles: Titles;
  onOpen: (item: string | null) => void;
  onStudy: (scope: string) => void;
}) {
  return (
    <>
      <header className="course-head">
        <div className="course-head-text">
          <span className="course-kicker">Unit {unit.number}</span>
          <h1>{titles.unit(unit)}</h1>
          {titles.unitQuestion(unit) && <p className="course-question">{titles.unitQuestion(unit)}</p>}
        </div>
        <div className="course-head-actions">
          <button type="button" className="primary-btn" disabled={unit.tally.cards === 0} onClick={() => onStudy(unit.id)}>
            {unit.tally.due > 0 ? `Study unit · ${unit.tally.due} due` : 'Study unit'}
          </button>
        </div>
      </header>
      {unit.description.length > 0 && (
        <div className="course-desc">
          {unit.description.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}
      <div className="course-summary course-summary-slim">
        <span>
          {tallyLine(unit.tally)}
          <DueNew t={unit.tally} />
        </span>
        <ProgressBar tally={unit.tally} />
      </div>

      <h2 className="course-section-title">Areas of study</h2>
      <ol className="tl">
        {unit.areas.map((area) => (
          <li key={area.id} className="tl-item">
            <Ring tally={area.tally} label={String(area.number)} />
            <button type="button" className="tl-card" onClick={() => onOpen(area.id)}>
              <span className="tl-kicker">Area of Study {area.number}</span>
              <span className="tl-title">{titles.area(unit, area)}</span>
              {titles.areaQuestion(unit, area) && <span className="tl-question">{titles.areaQuestion(unit, area)}</span>}
              {area.description[0] && <span className="tl-desc">{area.description[0]}</span>}
              <span className="tl-meta">
                {tallyLine(area.tally)}
                <DueNew t={area.tally} />
              </span>
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}

// ---------------------------------------------------------------------------
// Level 3 — an area of study: its learning points
// ---------------------------------------------------------------------------

function PointList({ groups, titles, onOpen }: { groups: GroupProgress[]; titles: Titles; onOpen: (item: string) => void }) {
  // Numbered straight through the area, across its sub-headings.
  const starts = groups.map((_, gi) => groups.slice(0, gi).reduce((sum, g) => sum + g.points.length, 0));
  return (
    <div className="course-points">
      {groups.map((group, gi) => (
        <section key={group.id ?? gi} className="course-point-group">
          {group.title && <h3>{group.title}</h3>}
          <ol className="tl tl-steps">
            {group.points.map((point, pi) => {
              const n = starts[gi]! + pi + 1;
              return (
                <li key={point.id} className={`tl-item status-${point.status}`}>
                  <span className="tl-step" aria-hidden="true">
                    {isStudied(point.status) ? '✓' : n}
                  </span>
                  <button type="button" className="tl-card tl-card-point" onClick={() => onOpen(point.id)}>
                    <span className="tl-point-title">{titles.point(point)}</span>
                    <span className="tl-point-text">{point.text}</span>
                    <span className="tl-meta">
                      <StatusIcon status={point.status} /> {STATUS_LABEL[point.status]}
                      {point.cards > 0 && ` · ${point.cards} card${point.cards === 1 ? '' : 's'}`}
                      <DueNew t={point} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

function AreaView({
  unit,
  area,
  titles,
  onOpen,
  onStudy,
}: {
  unit: UnitProgress;
  area: AreaProgress;
  titles: Titles;
  onOpen: (item: string | null) => void;
  onStudy: (scope: string) => void;
}) {
  return (
    <>
      <header className="course-head">
        <div className="course-head-text">
          <span className="course-kicker">
            Unit {unit.number} · Area of Study {area.number}
          </span>
          <h1>{titles.area(unit, area)}</h1>
          {titles.areaQuestion(unit, area) && <p className="course-question">{titles.areaQuestion(unit, area)}</p>}
        </div>
        <div className="course-head-actions">
          <button type="button" className="primary-btn" disabled={area.tally.cards === 0} onClick={() => onStudy(area.id)}>
            {area.tally.due > 0 ? `Study area · ${area.tally.due} due` : 'Study area'}
          </button>
        </div>
      </header>
      {area.description.length > 0 && (
        <div className="course-desc">
          {area.description.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}
      {area.outcome && (
        <div className="course-outcome">
          <span className="course-kicker">Outcome {area.number}</span>
          <p>{area.outcome}</p>
        </div>
      )}
      <div className="course-summary course-summary-slim">
        <span>
          {tallyLine(area.tally)}
          <DueNew t={area.tally} />
        </span>
        <ProgressBar tally={area.tally} />
      </div>
      <h2 className="course-section-title">Learning points</h2>
      <PointList groups={area.groups} titles={titles} onOpen={onOpen} />
    </>
  );
}

function SkillsView({
  skills,
  titles,
  onOpen,
  onStudy,
}: {
  skills: NonNullable<Roadmap['skills']>;
  titles: Titles;
  onOpen: (item: string | null) => void;
  onStudy: (scope: string) => void;
}) {
  return (
    <>
      <header className="course-head">
        <div className="course-head-text">
          <span className="course-kicker">Across every unit</span>
          <h1>Key science skills</h1>
        </div>
        <div className="course-head-actions">
          <button type="button" className="primary-btn" disabled={skills.tally.cards === 0} onClick={() => onStudy(skills.id)}>
            {skills.tally.due > 0 ? `Study skills · ${skills.tally.due} due` : 'Study skills'}
          </button>
        </div>
      </header>
      <div className="course-summary course-summary-slim">
        <span>
          {tallyLine(skills.tally)}
          <DueNew t={skills.tally} />
        </span>
        <ProgressBar tally={skills.tally} />
      </div>
      <PointList groups={skills.groups} titles={titles} onOpen={onOpen} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Level 4 — a learning point, as a lesson
// ---------------------------------------------------------------------------

function LessonView({
  place,
  titles,
  sequence,
  inTextbook,
  onOpen,
  onStudy,
  onZoomTo,
}: {
  place: Extract<Place, { kind: 'point' }>;
  titles: Titles;
  sequence: PointProgress[];
  inTextbook: SectionProgress[];
  onOpen: (item: string | null) => void;
  onStudy: (scope: string) => void;
  onZoomTo: (nodeId: string) => void;
}) {
  const { point, group, unit, area } = place;
  const lesson = useLiveQuery(() => loadLesson(point.id), [point.id]);
  const at = sequence.findIndex((p) => p.id === point.id);
  const prev = at > 0 ? sequence[at - 1] : undefined;
  const next = at >= 0 ? sequence[at + 1] : undefined;
  const hasBody = lesson?.body.some((r) => hasContent(r)) ?? false;

  return (
    <>
      <header className="lesson-head">
        <span className="course-kicker">
          {unit && area ? `Unit ${unit.number} · ${titles.area(unit, area)}` : 'Key science skills'}
          {group.title ? ` · ${group.title}` : ''}
        </span>
        <h1>{titles.point(point)}</h1>
        <p className="lesson-wording">
          <span className="lesson-wording-label">Study design</span> {point.text}
        </p>
        <div className="lesson-status">
          <span className={`lesson-chip status-${point.status}`}>
            <StatusIcon status={point.status} /> {STATUS_LABEL[point.status]}
          </span>
          {point.cards > 0 && (
            <span className="subject-dim">
              {point.cards} flashcard{point.cards === 1 ? '' : 's'}
              <DueNew t={point} />
            </span>
          )}
        </div>
        <div className="lesson-actions">
          {point.cards > 0 && (
            <button type="button" className="primary-btn" onClick={() => onStudy(point.id)}>
              {point.fresh > 0 ? `Learn ${point.fresh} card${point.fresh === 1 ? '' : 's'}` : point.due > 0 ? `Review ${point.due}` : 'Practise cards'}
            </button>
          )}
          <button type="button" className="ghost-btn" onClick={() => onZoomTo(point.id)}>
            {hasBody ? 'Edit notes' : 'Write notes'}
          </button>
        </div>
        {inTextbook.length > 0 && (
          <div className="lesson-links">
            <span className="lesson-wording-label">In the textbook</span>
            {inTextbook.map((s) => (
              <button key={s.id} type="button" className="lesson-link-chip" onClick={() => onOpen(s.id)}>
                {sectionHeading(s)}
              </button>
            ))}
          </div>
        )}
      </header>

      {lesson === undefined ? (
        <div className="view-loading">Loading…</div>
      ) : !hasBody ? (
        <div className="lesson-empty">
          <p>No notes for this learning point yet.</p>
          <p className="subject-dim">
            Write your own with <strong>Write notes</strong>, or use <strong>Add study notes</strong> on the course page.
          </p>
        </div>
      ) : (
        <LessonBody body={lesson!.body} />
      )}

      {lesson && lesson.linked.length > 0 && (
        <section className="lesson-section lesson-linked">
          <h2>From your other notes</h2>
          {lesson.linked.map((node) => (
            <button key={node.id} type="button" className="lesson-linked-item" onClick={() => onZoomTo(node.id)}>
              <ReadOnlyDoc doc={parseDoc(node.content)} className="lesson-text" />
            </button>
          ))}
        </section>
      )}

      <nav className="lesson-nav" aria-label="Other learning points">
        {prev ? (
          <button type="button" className="lesson-nav-btn" onClick={() => onOpen(prev.id)}>
            <span className="course-kicker">← Previous</span>
            <span>{titles.point(prev)}</span>
          </button>
        ) : (
          <span />
        )}
        {next ? (
          <button type="button" className="lesson-nav-btn lesson-nav-next" onClick={() => onOpen(next.id)}>
            <span className="course-kicker">Next →</span>
            <span>{titles.point(next)}</span>
          </button>
        ) : (
          <span />
        )}
      </nav>
    </>
  );
}

// ---------------------------------------------------------------------------
// The textbook: its chapters → a chapter's sections → a section as a lesson
// ---------------------------------------------------------------------------

function TextbookView({ book, onOpen, onStudy }: { book: TextbookProgress; onOpen: (item: string) => void; onStudy: (scope: string) => void }) {
  return (
    <>
      <header className="course-head">
        <div className="course-head-text">
          <span className="course-kicker">Textbook</span>
          <h1>{book.title}</h1>
          <p className="course-question">The same course, chapter by chapter in the book's order.</p>
        </div>
        <div className="course-head-actions">
          <button type="button" className="primary-btn" disabled={book.tally.cards === 0} onClick={() => onStudy(book.id)}>
            {book.tally.due > 0 ? `Study textbook · ${book.tally.due} due` : 'Study textbook'}
          </button>
        </div>
      </header>
      <div className="course-summary course-summary-slim">
        <span>
          {tallyLine(book.tally)}
          <DueNew t={book.tally} />
        </span>
        <ProgressBar tally={book.tally} />
      </div>
      <h2 className="course-section-title">Chapters</h2>
      <ol className="tl">
        {book.chapters.map((chapter) => (
          <li key={chapter.id} className="tl-item">
            <Ring tally={chapter.tally} label={String(chapter.number)} />
            <button type="button" className="tl-card" onClick={() => onOpen(chapter.id)}>
              <span className="tl-kicker">Chapter {chapter.number}</span>
              <span className="tl-title">{chapter.title}</span>
              <span className="tl-meta">
                {chapter.sections.length} section{chapter.sections.length === 1 ? '' : 's'} · {tallyLine(chapter.tally)}
                <DueNew t={chapter.tally} />
              </span>
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}

function ChapterView({ chapter, onOpen, onStudy }: { chapter: ChapterProgress; onOpen: (item: string) => void; onStudy: (scope: string) => void }) {
  return (
    <>
      <header className="course-head">
        <div className="course-head-text">
          <span className="course-kicker">Textbook · Chapter {chapter.number}</span>
          <h1>{chapter.title}</h1>
        </div>
        <div className="course-head-actions">
          <button type="button" className="primary-btn" disabled={chapter.tally.cards === 0} onClick={() => onStudy(chapter.id)}>
            {chapter.tally.due > 0 ? `Study chapter · ${chapter.tally.due} due` : 'Study chapter'}
          </button>
        </div>
      </header>
      <div className="course-summary course-summary-slim">
        <span>
          {tallyLine(chapter.tally)}
          <DueNew t={chapter.tally} />
        </span>
        <ProgressBar tally={chapter.tally} />
      </div>
      <h2 className="course-section-title">Sections</h2>
      <div className="course-points">
        <ol className="tl tl-steps">
          {chapter.sections.map((section) => (
            <li key={section.id} className={`tl-item status-${section.status}`}>
              <span className="tl-step" aria-hidden="true">
                {isStudied(section.status) ? '✓' : section.number}
              </span>
              <button type="button" className="tl-card tl-card-point" onClick={() => onOpen(section.id)}>
                <span className="tl-point-title">{sectionHeading(section)}</span>
                <span className="tl-meta">
                  <StatusIcon status={section.status} /> {STATUS_LABEL[section.status]}
                  {section.cards > 0 && ` · ${section.cards} card${section.cards === 1 ? '' : 's'}`}
                  <DueNew t={section} />
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}

function SectionView({
  place,
  covers,
  titles,
  onOpen,
  onStudy,
  onZoomTo,
}: {
  place: Extract<Place, { kind: 'section' }>;
  covers: PointProgress[];
  titles: Titles;
  onOpen: (item: string | null) => void;
  onStudy: (scope: string) => void;
  onZoomTo: (nodeId: string) => void;
}) {
  const { book, chapter, section } = place;
  const lesson = useLiveQuery(() => loadLesson(section.id), [section.id]);
  const sequence = book.chapters.flatMap((c) => c.sections);
  const at = sequence.findIndex((s) => s.id === section.id);
  const prev = at > 0 ? sequence[at - 1] : undefined;
  const next = at >= 0 ? sequence[at + 1] : undefined;
  const hasBody = lesson?.body.some((r) => hasContent(r)) ?? false;

  return (
    <>
      <header className="lesson-head">
        <span className="course-kicker">
          Chapter {chapter.number} · {chapter.title}
        </span>
        <h1>{sectionHeading(section)}</h1>
        {covers.length > 0 && (
          <div className="lesson-links">
            <span className="lesson-wording-label">Study design</span>
            {covers.map((p) => (
              <button key={p.id} type="button" className="lesson-link-chip" onClick={() => onOpen(p.id)}>
                {titles.point(p)}
              </button>
            ))}
          </div>
        )}
        <div className="lesson-status">
          <span className={`lesson-chip status-${section.status}`}>
            <StatusIcon status={section.status} /> {STATUS_LABEL[section.status]}
          </span>
          {section.cards > 0 && (
            <span className="subject-dim">
              {section.cards} flashcard{section.cards === 1 ? '' : 's'}
              <DueNew t={section} />
            </span>
          )}
        </div>
        <div className="lesson-actions">
          {section.cards > 0 && (
            <button type="button" className="primary-btn" onClick={() => onStudy(section.id)}>
              {section.fresh > 0
                ? `Learn ${section.fresh} card${section.fresh === 1 ? '' : 's'}`
                : section.due > 0
                  ? `Review ${section.due}`
                  : 'Practise cards'}
            </button>
          )}
          <button type="button" className="ghost-btn" onClick={() => onZoomTo(section.id)}>
            {hasBody ? 'Edit notes' : 'Write notes'}
          </button>
        </div>
      </header>

      {lesson === undefined ? (
        <div className="view-loading">Loading…</div>
      ) : !hasBody ? (
        <div className="lesson-empty">
          <p>No notes for this section yet.</p>
        </div>
      ) : (
        <LessonBody body={lesson!.body} />
      )}

      <nav className="lesson-nav" aria-label="Other sections">
        {prev ? (
          <button type="button" className="lesson-nav-btn" onClick={() => onOpen(prev.id)}>
            <span className="course-kicker">← Previous</span>
            <span>{sectionHeading(prev)}</span>
          </button>
        ) : (
          <span />
        )}
        {next ? (
          <button type="button" className="lesson-nav-btn lesson-nav-next" onClick={() => onOpen(next.id)}>
            <span className="course-kicker">Next →</span>
            <span>{sectionHeading(next)}</span>
          </button>
        ) : (
          <span />
        )}
      </nav>
    </>
  );
}

// ---------------------------------------------------------------------------
// Drawing the notes as a lesson
// ---------------------------------------------------------------------------

function hasContent(rem: LessonRem): boolean {
  const n = rem.node;
  return n.plainText.trim() !== '' || n.isPortal || n.content.includes('"remImage"') || n.content.includes('"remPdf"') || rem.children.some(hasContent);
}

/** A short rem that is all bold (or a heading) reads as a section title: "Key ideas", "Worked example". */
function sectionTitle(rem: LessonRem): string | null {
  const text = rem.node.plainText.trim();
  if (!text || text.length > 60 || rem.children.length === 0) return null;
  const doc = parseDoc(rem.node.content);
  const block = doc.content?.[0];
  if (!block || (doc.content?.length ?? 0) > 1) return null;
  if (block.type === 'heading') return text;
  const inline = block.content ?? [];
  const allBold = inline.length > 0 && inline.every((n) => n.type === 'text' && (n.marks ?? []).some((m) => m.type === 'bold'));
  return allBold ? text : null;
}

function clozesAll(doc: DocNode, revealed: boolean): DocNode {
  const walk = (node: DocNode): DocNode =>
    node.type === 'cloze'
      ? { ...node, attrs: { ...node.attrs, state: revealed ? 'revealed' : 'hidden' } }
      : node.content
        ? { ...node, content: node.content.map(walk) }
        : node;
  return walk(doc);
}

interface CardFaces {
  kind: 'cloze' | 'qa';
  front: DocNode;
  /** Cloze: the text with every blank filled. Q/A: the answer, or null when the children are the answer. */
  back: DocNode | null;
}

function cardFaces(doc: DocNode): CardFaces | null {
  if (extractClozeIndices(doc).length > 0) return { kind: 'cloze', front: clozesAll(doc, false), back: clozesAll(doc, true) };
  const sides = splitOnSeparator(doc);
  if (!sides) return null;
  const backEmpty = !(sides.back.content ?? []).some((b) => (b.content?.length ?? 0) > 0);
  return { kind: 'qa', front: sides.front, back: backEmpty ? null : sides.back };
}

/** A flashcard in the lesson: the question, and the answer when you ask for it. */
function FlipCard({ faces, children }: { faces: CardFaces; children?: ReactNode }) {
  const [shown, setShown] = useState(false);
  const top = faces.kind === 'cloze' && shown && faces.back ? faces.back : faces.front;
  return (
    <div className={`flip-card ${shown ? 'is-shown' : ''}`}>
      <ReadOnlyDoc doc={top} className="flip-card-front lesson-text" />
      {shown && faces.kind === 'qa' && faces.back && <ReadOnlyDoc doc={faces.back} className="flip-card-back lesson-text" />}
      {shown && children && <div className="flip-card-back">{children}</div>}
      <button type="button" className="flip-card-toggle" onClick={() => setShown((v) => !v)} aria-expanded={shown}>
        {shown ? 'Hide answer' : 'Show answer'}
      </button>
    </div>
  );
}

function LessonBlock({ rem }: { rem: LessonRem }) {
  if (!hasContent(rem)) return null;
  const doc = parseDoc(rem.node.content);
  const faces = rem.node.isPortal ? null : cardFaces(doc);
  const kids = rem.children.filter(hasContent);
  if (faces) {
    return (
      <FlipCard faces={faces}>
        {kids.length > 0 ? (
          <div className="lesson-sub">
            {kids.map((c) => (
              <LessonBlock key={c.node.id} rem={c} />
            ))}
          </div>
        ) : undefined}
      </FlipCard>
    );
  }
  return (
    <div className="lesson-block">
      <ReadOnlyDoc doc={doc} className="lesson-text" />
      {kids.length > 0 && (
        <div className="lesson-sub">
          {kids.map((c) => (
            <LessonBlock key={c.node.id} rem={c} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A practice question: the question, and its model answer (the rems under it)
 * behind a button. Not a flashcard — nothing is scheduled.
 */
function PracticeQuestion({ rem, number }: { rem: LessonRem; number: number }) {
  const [shown, setShown] = useState(false);
  const answer = rem.children.filter(hasContent);
  return (
    <div className={`practice-q ${shown ? 'is-shown' : ''}`}>
      <span className="practice-q-number">{number}</span>
      <div className="practice-q-body">
        <ReadOnlyDoc doc={parseDoc(rem.node.content)} className="lesson-text" />
        {shown && answer.length > 0 && (
          <div className="practice-q-answer">
            {answer.map((c) => (
              <LessonBlock key={c.node.id} rem={c} />
            ))}
          </div>
        )}
        {answer.length > 0 && (
          <button type="button" className="flip-card-toggle" onClick={() => setShown((v) => !v)} aria-expanded={shown}>
            {shown ? 'Hide answer' : 'Show answer'}
          </button>
        )}
      </div>
    </div>
  );
}

function LessonBody({ body }: { body: LessonRem[] }) {
  // Loose rems at the top level (your own notes, usually) gather into one untitled section.
  const sections: Array<{ title: string | null; id: string; rems: LessonRem[] }> = [];
  for (const rem of body.filter(hasContent)) {
    const title = sectionTitle(rem);
    if (title) sections.push({ title, id: rem.node.id, rems: rem.children });
    else {
      const last = sections[sections.length - 1];
      if (last && last.title === null) last.rems.push(rem);
      else sections.push({ title: null, id: rem.node.id, rems: [rem] });
    }
  }
  return (
    <div className="lesson-body">
      {sections.map((section) => {
        const kind = section.title?.toLowerCase();
        const isCards = kind === 'flashcards';
        const isPractice = kind === 'practice questions';
        return (
          <section
            key={section.id}
            className={`lesson-section ${isCards ? 'lesson-cards' : ''} ${isPractice ? 'lesson-practice' : ''}`}
          >
            {section.title && <h2>{section.title}</h2>}
            {section.rems
              .filter(hasContent)
              .map((rem, i) =>
                isPractice ? <PracticeQuestion key={rem.node.id} rem={rem} number={i + 1} /> : <LessonBlock key={rem.node.id} rem={rem} />
              )}
          </section>
        );
      })}
    </div>
  );
}

function Legend() {
  return (
    <div className="roadmap-legend" aria-label="Legend">
      {(Object.keys(STATUS_LABEL) as PointStatus[]).map((status) => (
        <span key={status}>
          <StatusIcon status={status} /> {STATUS_LABEL[status]}
        </span>
      ))}
      <span className="subject-dim">
        Studied = your own notes, or every card reviewed at least once. Mastered = every card out at 3+ weeks.
      </span>
    </div>
  );
}
