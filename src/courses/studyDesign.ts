import { strFromU8, unzipSync } from 'fflate';

/**
 * Reading a study design (VCAA's layout) into a tree of units, areas of study,
 * outcomes and key knowledge dot points.
 *
 * Study designs are not bundled with the app — they are VCAA's copyright and
 * the repo is public — so the user imports the one they downloaded, either the
 * `.docx` VCAA publishes or text pasted from it. Both become the same list of
 * `SourceLine`s and go through one parser.
 *
 * The parser is driven by the wording VCAA uses in every study design, not by
 * page layout: "Unit 1: <question>", "Area of Study 1" + a question, "Outcome
 * 1" + a statement, "Key knowledge", then bold sub-headings with dot points
 * under them, until "Assessment" or the next area. Everything else (the prose
 * introductions, investigation topics, assessment task lists) is skipped.
 * The import screen shows what was found before anything is written, which is
 * the real safety net for a layout this doesn't expect.
 */

export interface SourceLine {
  text: string;
  /** A dot point: a bullet glyph in pasted text, or a list paragraph in a .docx. */
  bullet: boolean;
  /** A heading-styled paragraph (.docx only — pasted text can't say). */
  heading?: boolean;
  /** 2 for a dot point nested under another ("quantitative analysis of salts:" → its parts). */
  level?: number;
}

export interface KeyKnowledgeGroup {
  /** The bold sub-heading, or null for dot points that sit directly under "Key knowledge". */
  title: string | null;
  points: string[];
}

export interface AreaOfStudy {
  number: number;
  title: string;
  /** The introduction under the area's question, as paragraphs. */
  description: string[];
  outcome: string | null;
  groups: KeyKnowledgeGroup[];
}

export interface StudyUnit {
  number: number;
  title: string;
  /** The introduction under the unit heading, as paragraphs. */
  description: string[];
  areas: AreaOfStudy[];
}

export interface StudyDesign {
  units: StudyUnit[];
  /** "Key science skills" (or similar) — common to every unit. Empty when the source has none. */
  skills: KeyKnowledgeGroup[];
}

export interface ParsedStudyDesign {
  design: StudyDesign;
  /** Things worth showing before the import is confirmed. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Sources → lines
// ---------------------------------------------------------------------------

const BULLET_GLYPH = /^[•●▪◦‣∙○■□➢➤✓•]\s*/;
const BULLET_DASH = /^[-–—*]\s+/;

function clean(text: string): string {
  return text.replace(/[   \t]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Pasted text: one line per line, bullets recognised by their glyph. */
export function textToLines(text: string): SourceLine[] {
  return text.split(/\r?\n/).map((raw) => {
    const line = clean(raw);
    const glyph = BULLET_GLYPH.exec(line) ?? BULLET_DASH.exec(line) ?? /^o\s+/.exec(line);
    if (!glyph) return { text: line, bullet: false };
    // Nested: an indented bullet, or the hollow glyphs Word uses for level two.
    const nested = /^[ \t\u00a0]{2,}/.test(raw) || /^[◦○o]/.test(line);
    return { text: line.slice(glyph[0].length).trim(), bullet: true, ...(nested ? { level: 2 } : {}) };
  });
}

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '–': '⁻', '(': '⁽', ')': '⁾', n: 'ⁿ',
};
const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '−': '₋', '(': '₍', ')': '₎',
};

/**
 * Raised and lowered text as Unicode — `10²³`, `H₂O` — so it survives into
 * plain text, search and card faces without a new mark. Characters with no
 * Unicode form are left as they are.
 */
function shift(text: string, table: Record<string, string>): string {
  return [...text].map((ch) => table[ch] ?? ch).join('');
}

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const PARAGRAPH = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
const RUN = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
const RUN_PIECE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr|noBreakHyphen)\b[^>]*\/>/g;

/** One `<w:p>` → its text, with superscript/subscript runs turned into Unicode. */
function paragraphText(xml: string): string {
  let out = '';
  RUN.lastIndex = 0;
  let run: RegExpExecArray | null;
  while ((run = RUN.exec(xml)) !== null) {
    const body = run[1]!;
    const align = /<w:vertAlign w:val="(superscript|subscript)"/.exec(body)?.[1];
    RUN_PIECE.lastIndex = 0;
    let piece: RegExpExecArray | null;
    while ((piece = RUN_PIECE.exec(body)) !== null) {
      if (piece[2]) {
        out += piece[2] === 'noBreakHyphen' ? '-' : ' ';
        continue;
      }
      const text = decodeXml(piece[1] ?? '');
      out += align === 'superscript' ? shift(text, SUPERSCRIPT) : align === 'subscript' ? shift(text, SUBSCRIPT) : text;
    }
  }
  return out;
}

/**
 * A `.docx` → lines, one per paragraph. List paragraphs (numbering, or a
 * style with "bullet"/"list" in its name — VCAA's `VCAAbullet`) are dot
 * points; heading styles are marked so the parser knows where sections end.
 * Pure: no DOM, so it runs in tests as it does in the browser.
 */
export function docxToLines(bytes: Uint8Array): SourceLine[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (file) => file.name === 'word/document.xml' });
  } catch {
    throw new Error("That file isn't a Word document (.docx).");
  }
  const documentXml = files['word/document.xml'];
  if (!documentXml) throw new Error("That file isn't a Word document (.docx).");
  const xml = strFromU8(documentXml);

  const lines: SourceLine[] = [];
  PARAGRAPH.lastIndex = 0;
  let para: RegExpExecArray | null;
  while ((para = PARAGRAPH.exec(xml)) !== null) {
    const body = para[1]!;
    const style = /<w:pStyle w:val="([^"]*)"/.exec(body)?.[1] ?? '';
    const bullet = /<w:numPr>/.test(body) || /bullet|list/i.test(style);
    const heading = /heading|title/i.test(style) && !/toc/i.test(style);
    const ilvl = Number(/<w:ilvl w:val="(\d)"/.exec(body)?.[1] ?? 0);
    const styleLevel = Number(/level\s*([2-9])/i.exec(style)?.[1] ?? 1);
    const level = Math.max(ilvl + 1, styleLevel);
    lines.push({ text: clean(paragraphText(body)), bullet, heading, ...(bullet && level > 1 ? { level } : {}) });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Lines → design
// ---------------------------------------------------------------------------

const SEP = String.raw`\s*[:：.–—-]\s*`;
const UNIT = new RegExp(String.raw`^Unit\s+([1-9])(?:${SEP}(.*))?$`, 'i');
const AREA = new RegExp(String.raw`^Area\s+of\s+Study\s+([1-9])(?:${SEP}(.*))?$`, 'i');
const OUTCOME = new RegExp(String.raw`^Outcome\s+([1-9])(?:${SEP}(.*))?$`, 'i');
const KEY_KNOWLEDGE = /^Key\s+knowledge$/i;
const SKILLS = /^Key\s+(?:science\s+)?skills$/i;
/** Group titles for an area whose outcome lists both key knowledge and key skills. */
export const KEY_KNOWLEDGE_TITLE = 'Key knowledge';
export const KEY_SKILLS_TITLE = 'Key skills';
/** Headings that end an area of study's key knowledge — and the area itself. */
const AREA_END = /^(?:Assessment|School-based assessment|Satisfactory completion|External assessment)$/i;
const OUTCOME_TAIL = /^To achieve this outcome/i;
/** Running headers, footers, page numbers, table column headings. */
const NOISE = [
  /^\d{1,3}$/,
  /^page\s+\d+(?:\s+of\s+\d+)?$/i,
  /^©/,
  /^VCE\b.*\bStudy Design\b/i,
  /^Key science skill$/i, // the skills table's column heading
  /^VCE\s+\S+(?:\s+\S+)?\s+Units?\s+\d/i, // "VCE Chemistry Units 1–4" column heading
];

function isNoise(text: string): boolean {
  return NOISE.some((re) => re.test(text));
}

/** "…explained?23" (a contents line with its page number) → "…explained?" */
function stripPageNumber(title: string): string {
  return title.replace(/(\?)\s*\.*\s*\d{1,3}$/, '$1').replace(/\s*\.{3,}\s*\d{1,3}$/, '').trim();
}

/** A wrapped line from pasted PDF text that belongs to the dot point above it. */
function continues(text: string, previous: string): boolean {
  if (/^[a-z0-9(,;:)–-]/.test(text)) return true;
  if (/[-–,;:(]$|\b(?:and|or|of|the|a|an|to|in|for|with|by|as|from|including)$/i.test(previous)) return true;
  return text.length > 100;
}

type Mode = 'none' | 'unit-title' | 'unit-desc' | 'area-title' | 'area-desc' | 'outcome' | 'knowledge' | 'skills';

/** Introductions are kept short: the first few paragraphs say what a unit or area is about. */
const MAX_DESCRIPTION_PARAGRAPHS = { unit: 4, area: 2 };

export interface ParseOptions {
  /** Keep only these units (e.g. [1, 2]). All units when absent. */
  units?: readonly number[];
  /**
   * True when every line is a whole paragraph (a .docx). Pasted text can wrap
   * one dot point over several lines, so there the parser joins them.
   */
  exact?: boolean;
}

export function parseStudyDesign(lines: readonly SourceLine[], options: ParseOptions = {}): ParsedStudyDesign {
  const exact = options.exact ?? false;
  const units = new Map<number, StudyUnit>();
  const skills: KeyKnowledgeGroup[] = [];
  let unit: StudyUnit | null = null;
  let area: AreaOfStudy | null = null;
  // One object rather than four `let`s: `startList` changes them from a
  // closure, which TypeScript's narrowing can't see.
  const st: {
    mode: Mode;
    groups: KeyKnowledgeGroup[] | null; // where dot points go in this mode
    lastPoint: { group: KeyKnowledgeGroup; index: number } | null;
    stem: { group: KeyKnowledgeGroup; index: number; text: string; used: boolean } | null;
  } = { mode: 'none', groups: null, lastPoint: null, stem: null };

  const startList = (target: KeyKnowledgeGroup[], next: Mode) => {
    st.mode = next;
    st.groups = target;
    st.lastPoint = null;
    st.stem = null;
  };

  for (const line of lines) {
    const text = line.text;
    if (!text || isNoise(text)) continue;

    const unitMatch = UNIT.exec(text);
    if (unitMatch) {
      const number = Number(unitMatch[1]);
      const title = stripPageNumber(unitMatch[2] ?? '');
      const existing = units.get(number);
      // A contents entry or an overview bullet comes before the real heading
      // and has no areas under it; a running header repeats after it. Only
      // the first kind gets replaced.
      if (existing && existing.areas.length > 0) continue;
      unit = { number, title: title || existing?.title || '', description: [], areas: [] };
      units.set(number, unit);
      area = null;
      st.mode = title ? 'unit-desc' : 'unit-title';
      continue;
    }

    const areaMatch = AREA.exec(text);
    if (areaMatch && unit) {
      const number = Number(areaMatch[1]);
      const title = stripPageNumber(areaMatch[2] ?? '');
      const existing = unit.areas.find((a) => a.number === number);
      if (existing) {
        // A running header, or the same heading met twice: carry on in it.
        area = existing;
        continue;
      }
      area = { number, title, description: [], outcome: null, groups: [] };
      unit.areas.push(area);
      st.mode = title ? 'area-desc' : 'area-title';
      continue;
    }

    const outcomeMatch = OUTCOME.exec(text);
    if (outcomeMatch && area) {
      // Only the first: "Outcome 3" also turns up again in assessment tables.
      if (area.outcome === null) {
        area.outcome = outcomeMatch[2]?.trim() ?? '';
        st.mode = 'outcome';
      }
      continue;
    }

    if (KEY_KNOWLEDGE.test(text) && area) {
      startList(area.groups, 'knowledge');
      continue;
    }

    if (SKILLS.test(text.replace(/\s*\d+$/, '')) && !line.bullet) {
      // The study-wide skills section sits before Unit 1. A "Key skills" list
      // inside an area (English Language has one per outcome) becomes its own
      // group in that area, and the key knowledge before it is labelled as such.
      if (area) {
        for (const g of area.groups) g.title ??= KEY_KNOWLEDGE_TITLE;
        area.groups.push({ title: KEY_SKILLS_TITLE, points: [] });
        startList(area.groups, 'knowledge');
      } else startList(skills, 'skills');
      continue;
    }

    if (AREA_END.test(text)) {
      area = null;
      st.mode = 'none';
      continue;
    }

    switch (st.mode) {
      case 'unit-title':
        if (unit) unit.title = stripPageNumber(text);
        st.mode = 'unit-desc';
        break;

      case 'area-title':
        if (area) area.title = stripPageNumber(text);
        st.mode = 'area-desc';
        break;

      case 'unit-desc':
      case 'area-desc': {
        // Prose until a heading, a list or the next section. Pasted text wraps
        // a paragraph over several lines, so there it all joins into one.
        const target = st.mode === 'unit-desc' ? unit?.description : area?.description;
        const max = st.mode === 'unit-desc' ? MAX_DESCRIPTION_PARAGRAPHS.unit : MAX_DESCRIPTION_PARAGRAPHS.area;
        if (!target || line.bullet || line.heading || /^Investigation topic/i.test(text)) {
          st.mode = 'none';
        } else if (!exact && target.length > 0) {
          target[target.length - 1] = `${target[target.length - 1]} ${text}`;
        } else if (target.length < max) {
          target.push(text);
        }
        break;
      }

      case 'outcome':
        if (!area || OUTCOME_TAIL.test(text) || line.bullet || line.heading) {
          st.mode = 'none';
        } else if (!area.outcome) {
          area.outcome = text;
          if (exact) st.mode = 'none';
        } else if (exact) {
          st.mode = 'none';
        } else {
          area.outcome = `${area.outcome} ${text}`;
        }
        break;

      case 'knowledge':
      case 'skills': {
        const target = st.groups as KeyKnowledgeGroup[] | null;
        if (!target) break;
        if (line.bullet) {
          let group = target[target.length - 1];
          if (!group) {
            group = { title: null, points: [] };
            target.push(group);
          }
          if ((line.level ?? 1) > 1 && st.lastPoint) {
            // "quantitative analysis of salts:" + its parts → one dot point per
            // part, each carrying the stem, so each can be tracked on its own.
            if (!st.stem || st.stem.group !== st.lastPoint.group || st.stem.index !== st.lastPoint.index) {
              st.stem = { ...st.lastPoint, text: st.lastPoint.group.points[st.lastPoint.index]!.replace(/[:;,]?\s*$/, ''), used: false };
            }
            const joined = `${st.stem.text}: ${text}`;
            if (!st.stem.used) {
              st.stem.group.points[st.stem.index] = joined;
              st.stem.used = true;
            } else {
              st.stem.group.points.push(joined);
            }
            // Wrapped lines of a part join the part; the next part starts again from the stem.
            st.lastPoint = { group: st.stem.group, index: st.stem.group.points.length - 1 };
            st.stem.index = st.lastPoint.index;
            break;
          }
          group.points.push(text);
          st.lastPoint = { group, index: group.points.length - 1 };
          st.stem = null;
          break;
        }
        // A heading-styled line that isn't a sub-heading ends the section.
        if (st.mode === 'skills' && line.heading) {
          st.mode = 'none';
          break;
        }
        if (!exact && st.lastPoint) {
          const previous = st.lastPoint.group.points[st.lastPoint.index]!;
          if (continues(text, previous)) {
            st.lastPoint.group.points[st.lastPoint.index] = previous.endsWith('-') ? previous + text : `${previous} ${text}`;
            break;
          }
        }
        // Prose (a long sentence) is not a sub-heading: in the skills section
        // it means the table is over; under key knowledge, skip it.
        if (text.length > 120 || /\.$/.test(text)) {
          // …but the skills section opens with a paragraph or two before its table.
          if (st.mode === 'skills' && target.some((g) => g.points.length > 0)) st.mode = 'none';
          break;
        }
        target.push({ title: text.replace(/:$/, ''), points: [] });
        st.lastPoint = null;
        break;
      }

      default:
        break;
    }
  }

  // Pasted text with no bullet glyphs: every line became a sub-heading. VCAA
  // dot points start lower-case and sub-headings don't, so sort them again.
  for (const u of units.values()) for (const a of u.areas) a.groups = regroupWithoutBullets(a.groups);

  const wanted = options.units ? new Set(options.units) : null;
  const kept = [...units.values()]
    .filter((u) => u.areas.length > 0 && (!wanted || wanted.has(u.number)))
    .sort((a, b) => a.number - b.number);
  for (const u of kept) for (const a of u.areas) a.groups = a.groups.filter((g) => g.points.length > 0);

  const warnings: string[] = [];
  if (kept.length === 0) {
    warnings.push(
      wanted
        ? `Couldn't find Unit ${[...wanted].join(' or Unit ')} in this study design.`
        : "Couldn't find any units. Is this a VCAA study design?"
    );
  }
  if (wanted) {
    for (const n of wanted) if (!kept.some((u) => u.number === n) && kept.length > 0) warnings.push(`Unit ${n} wasn't found.`);
  }
  for (const u of kept) {
    if (!u.title) warnings.push(`Unit ${u.number} has no title.`);
    for (const a of u.areas) {
      if (!a.groups.some((g) => g.points.length > 0)) warnings.push(`Unit ${u.number}, Area of Study ${a.number} has no key knowledge.`);
      if (!a.title) warnings.push(`Unit ${u.number}, Area of Study ${a.number} has no title.`);
    }
  }

  return { design: { units: kept, skills: skills.filter((g) => g.points.length > 0) }, warnings };
}

function regroupWithoutBullets(groups: KeyKnowledgeGroup[]): KeyKnowledgeGroup[] {
  if (groups.some((g) => g.points.length > 0)) return groups;
  const out: KeyKnowledgeGroup[] = [];
  for (const { title } of groups) {
    if (!title) continue;
    if (/^[a-z]/.test(title)) {
      let group = out[out.length - 1];
      if (!group) {
        group = { title: null, points: [] };
        out.push(group);
      }
      group.points.push(title);
    } else {
      out.push({ title, points: [] });
    }
  }
  return out;
}

/** Totals for the preview. */
export function countPoints(design: StudyDesign): { areas: number; points: number; skills: number; areaSkills: number } {
  let areas = 0;
  let points = 0;
  let areaSkills = 0;
  for (const u of design.units) {
    areas += u.areas.length;
    for (const a of u.areas) {
      for (const g of a.groups) {
        if (g.title === KEY_SKILLS_TITLE) areaSkills += g.points.length;
        else points += g.points.length;
      }
    }
  }
  return { areas, points, skills: design.skills.reduce((n, g) => n + g.points.length, 0), areaSkills };
}
