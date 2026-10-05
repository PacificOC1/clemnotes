import { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CATALOGUE, unitsLabel, type CatalogueSubject } from '../courses/catalogue';
import {
  countPoints,
  docxToLines,
  parseStudyDesign,
  textToLines,
  type ParsedStudyDesign,
} from '../courses/studyDesign';
import { getCourses, importStudyDesign, loadRoadmap, type CourseSummary } from '../db/courseRepository';
import { CourseBrowser, ProgressBar } from './CourseBrowser';
import './CoursesView.css';

interface CoursesViewProps {
  /** The course open; null = the subject list. */
  courseId: string | null;
  /** Inside the course: the unit, area of study or learning point open; null = the course overview. */
  courseItem: string | null;
  onOpenCourse: (courseId: string | null, item?: string | null) => void;
  /** Review the cards of a course page, or of a rem inside it. */
  onStudy: (scope: string) => void;
  onZoomTo: (nodeId: string) => void;
}

export function CoursesView({ courseId, courseItem, onOpenCourse, onStudy, onZoomTo }: CoursesViewProps) {
  return courseId ? (
    <CourseBrowser
      key={courseId}
      pageId={courseId}
      item={courseItem}
      onOpen={(item) => onOpenCourse(courseId, item)}
      onBackToCourses={() => onOpenCourse(null)}
      onStudy={onStudy}
      onZoomTo={onZoomTo}
    />
  ) : (
    <SubjectList onOpenCourse={(id) => onOpenCourse(id)} />
  );
}

// ---------------------------------------------------------------------------
// Subject list
// ---------------------------------------------------------------------------

function SubjectList({ onOpenCourse }: { onOpenCourse: (id: string) => void }) {
  const courses = useLiveQuery(() => getCourses(), []);
  const [importing, setImporting] = useState<string | null>(null);

  const bySubject = useMemo(() => {
    const map = new Map<string, CourseSummary>();
    for (const c of courses ?? []) if (c.subject) map.set(c.subject.id, c);
    return map;
  }, [courses]);
  const others = (courses ?? []).filter((c) => !c.subject);

  return (
    <div className="courses">
      <header className="courses-header">
        <h1>Courses</h1>
        <p>
          Pick a subject and import its study design. Every key knowledge dot point becomes a rem you can write notes
          under, and the roadmap shows how much of the course you've covered.
        </p>
      </header>

      <ul className="subject-list">
        {CATALOGUE.map((subject) => {
          const course = bySubject.get(subject.id);
          return (
            <li key={subject.id} className="subject-card">
              <div className="subject-card-main">
                <span className="subject-badge">{subject.curriculum}</span>
                <div className="subject-card-text">
                  <h2>{subject.title}</h2>
                  <p>
                    {unitsLabel(subject.units)}
                    {subject.laterUnits.length > 0 && (
                      <span className="subject-later"> · {unitsLabel(subject.laterUnits)} later</span>
                    )}
                    <span className="subject-dim"> · study design {subject.accredited}</span>
                  </p>
                </div>
                {course ? (
                  <button type="button" className="primary-btn" onClick={() => onOpenCourse(course.pageId)}>
                    Open roadmap
                  </button>
                ) : importing !== subject.id ? (
                  <button type="button" className="ghost-btn" onClick={() => setImporting(subject.id)}>
                    Import study design
                  </button>
                ) : null}
              </div>
              {course && <CourseProgressLine pageId={course.pageId} />}
              {!course && importing === subject.id && (
                <ImportPanel
                  subject={subject}
                  onCancel={() => setImporting(null)}
                  onImported={(pageId) => {
                    setImporting(null);
                    onOpenCourse(pageId);
                  }}
                />
              )}
            </li>
          );
        })}
        {others.map((course) => (
          <li key={course.pageId} className="subject-card">
            <div className="subject-card-main">
              <span className="subject-badge subject-badge-own">Own</span>
              <div className="subject-card-text">
                <h2>{course.title}</h2>
                <p className="subject-dim">A page in your Courses folder</p>
              </div>
              <button type="button" className="ghost-btn" onClick={() => onOpenCourse(course.pageId)}>
                Open roadmap
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CourseProgressLine({ pageId }: { pageId: string }) {
  const roadmap = useLiveQuery(() => loadRoadmap(pageId), [pageId]);
  if (!roadmap) return null;
  const { tally } = roadmap;
  return (
    <div className="subject-progress">
      <ProgressBar tally={tally} />
      <span>
        {tally.studied} of {tally.points} dot points studied
        {tally.due > 0 && <span className="course-due"> · {tally.due} due</span>}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function ImportPanel({
  subject,
  onCancel,
  onImported,
}: {
  subject: CatalogueSubject;
  onCancel: () => void;
  onImported: (pageId: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [parsed, setParsed] = useState<ParsedStudyDesign | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function readFile(file: File) {
    setError(null);
    setParsed(null);
    if (!/\.docx$/i.test(file.name)) {
      setError('Choose the .docx version of the study design (VCAA publishes one), or paste its text instead.');
      return;
    }
    try {
      const lines = docxToLines(new Uint8Array(await file.arrayBuffer()));
      setParsed(parseStudyDesign(lines, { units: subject.units, exact: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function readPasted() {
    setError(null);
    setParsed(parseStudyDesign(textToLines(pasted), { units: subject.units }));
  }

  async function create() {
    if (!parsed) return;
    setBusy(true);
    try {
      const { pageId } = await importStudyDesign(subject, parsed.design);
      onImported(pageId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const counts = parsed ? countPoints(parsed.design) : null;

  return (
    <div className="import-panel">
      {!parsed && (
        <>
          <ol className="import-steps">
            <li>
              Download the study design from{' '}
              <a href={subject.sourceUrl} target="_blank" rel="noreferrer">
                {subject.sourceName}
              </a>
              .
            </li>
            <li>Drop the .docx here. Only {unitsLabel(subject.units)} are imported for now.</li>
          </ol>
          {!pasting ? (
            <div
              className={`import-drop ${dragging ? 'is-dragging' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files[0];
                if (file) void readFile(file);
              }}
            >
              <button type="button" className="primary-btn" onClick={() => fileInput.current?.click()}>
                Choose study design…
              </button>
              <span>or drop it here</span>
              <input
                ref={fileInput}
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void readFile(file);
                }}
              />
            </div>
          ) : (
            <div className="import-paste">
              <textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder={'Unit 1: …\nArea of Study 1\n…\nKey knowledge\n…'}
                rows={10}
                aria-label="Study design text"
              />
              <button type="button" className="primary-btn" disabled={!pasted.trim()} onClick={readPasted}>
                Read it
              </button>
            </div>
          )}
          <div className="import-actions">
            <button type="button" className="link-btn" onClick={() => setPasting((p) => !p)}>
              {pasting ? 'Use the .docx instead' : 'Paste the text instead'}
            </button>
            <button type="button" className="ghost-btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}

      {error && <p className="import-error">{error}</p>}

      {parsed && counts && (
        <div className="import-preview">
          <p className="import-summary">
            Found {counts.areas} area{counts.areas === 1 ? '' : 's'} of study and {counts.points} key knowledge dot points
            {counts.areaSkills > 0 && ` and ${counts.areaSkills} key skills`}
            {counts.skills > 0 && `, plus ${counts.skills} key science skills`}. Check it looks right:
          </p>
          {parsed.warnings.length > 0 && (
            <ul className="import-warnings">
              {parsed.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <div className="import-tree">
            {parsed.design.units.map((unit) => (
              <details key={unit.number} open>
                <summary>
                  <strong>Unit {unit.number}</strong> {unit.title}
                </summary>
                {unit.areas.map((area) => (
                  <details key={area.number}>
                    <summary>
                      Area of Study {area.number}: {area.title}{' '}
                      <span className="subject-dim">
                        · {area.groups.reduce((n, g) => n + g.points.length, 0)} dot points
                      </span>
                    </summary>
                    {area.groups.map((group, i) => (
                      <div key={i} className="import-group">
                        {group.title && <div className="import-group-title">{group.title}</div>}
                        <ul>
                          {group.points.map((p, j) => (
                            <li key={j}>{p}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </details>
                ))}
              </details>
            ))}
          </div>
          <div className="import-actions">
            <button type="button" className="primary-btn" disabled={busy || counts.points + counts.areaSkills === 0} onClick={() => void create()}>
              {busy ? 'Creating…' : `Create ${subject.title}`}
            </button>
            <button type="button" className="ghost-btn" disabled={busy} onClick={() => setParsed(null)}>
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
