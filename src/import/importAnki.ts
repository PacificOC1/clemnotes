import { v4 as uuid } from 'uuid';
import type { SqlJsStatic } from 'sql.js';
import { db } from '../db/database';
import { createPagesWithTrees, type DraftPage, type DraftRem } from '../db/treeInsert';
import { ensureFolderNamed } from '../db/folderRepository';
import { findTagPages, TAGS_FOLDER_NAME } from '../db/tags';
import { storeImage } from '../db/imageRepository';
import { DEFAULT_EASE, MIN_EASE } from '../srs/sm2';
import { docFromText, type DocNode } from '../tiptap/docUtils';
import type { Flashcard, ReviewLogEntry, ReviewState } from '../db/schema';
import { fieldToInline } from './ankiHtml';
import { readApkg, type AnkiCard, type AnkiCollection, type AnkiNote, type AnkiReview } from './anki';

/**
 * Importing an Anki deck: notes become rems, and — the part that matters —
 * each card keeps its schedule and its whole review history.
 *
 * - **Decks** become pages (one per top-level deck), with sub-decks as heading
 *   rems inside, filed in an "Anki" folder.
 * - **Basic** notes become `Front :: Back`; a note with a reverse card becomes
 *   a two-way card. **Cloze** notes keep their `{{c1::…}}` blanks as clozes,
 *   numbered as Anki numbered them. Extra fields become child rems.
 * - **Scheduling**: interval, ease, lapses, due date and suspension carry over.
 * - **Review history**: every Anki review goes into the review log, so FSRS
 *   schedules imported cards from their real history from the first day, and
 *   "Fit to my reviews" can learn from years of it.
 * - **Tags** become `#tags` (Anki's `a::b` hierarchy as `a/b`), **images** are
 *   stored like pasted ones.
 */

export interface AnkiImportReport {
  decks: number;
  notes: number;
  cards: number;
  reviews: number;
  images: number;
  skippedNotes: number;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

/** Anki's 1–4 buttons → the SM-2 quality the review log stores (0, 3, 4, 5). */
export function qualityForEase(ease: number): number {
  return ease <= 1 ? 0 : ease === 2 ? 3 : ease === 3 ? 4 : 5;
}

function tagName(ankiTag: string): string {
  return ankiTag.replace(/::/g, '/');
}

function paragraphOf(inline: DocNode[]): DocNode {
  return inline.length > 0 ? { type: 'paragraph', content: inline } : { type: 'paragraph' };
}

interface NoteBuild {
  draft: DraftRem;
  imageNames: string[];
  tags: string[];
}

/** One Anki note as a rem (and its children). `hasReverse` = a card with ord 1 exists. */
function noteToDraft(note: AnkiNote, isCloze: boolean, fieldNames: string[], hasReverse: boolean): NoteBuild {
  const imageNames: string[] = [];
  const parsed = note.fields.map((field) => {
    const content = fieldToInline(field);
    imageNames.push(...content.images);
    return content;
  });
  const imageBlocks = (names: string[]): DocNode[] =>
    names.map((src) => ({ type: 'remImage', attrs: { imageId: null, alt: '', size: 'full', src } }));

  const children: DraftRem[] = [];
  let doc: DocNode;
  const extraFrom = isCloze ? 1 : 2;

  if (isCloze) {
    const [text] = parsed;
    doc = { type: 'doc', content: [paragraphOf(text?.inline ?? []), ...imageBlocks(text?.images ?? [])] };
  } else {
    const [front, back] = parsed;
    const inline: DocNode[] = [...(front?.inline ?? []), { type: 'text', text: ' :: ' }, ...(back?.inline ?? [])];
    doc = {
      type: 'doc',
      content: [paragraphOf(inline), ...imageBlocks([...(front?.images ?? []), ...(back?.images ?? [])])],
    };
  }

  parsed.slice(extraFrom).forEach((field, i) => {
    if (field.inline.length === 0 && field.images.length === 0) return;
    const name = fieldNames[i + extraFrom];
    const label: DocNode[] = name ? [{ type: 'text', text: `${name}: `, marks: [{ type: 'bold' }] }] : [];
    children.push({ doc: { type: 'doc', content: [paragraphOf([...label, ...field.inline]), ...imageBlocks(field.images)] } });
  });

  const tags = note.tags.map(tagName);
  const backEmpty = !isCloze && (parsed[1]?.inline.length ?? 0) === 0;
  // Tags as a child rem — except under `Front ::` with nothing after it,
  // where children *are* the answer.
  if (tags.length > 0 && !backEmpty) {
    const content: DocNode[] = [];
    tags.forEach((tag, i) => {
      if (i > 0) content.push({ type: 'text', text: ' ' });
      content.push({ type: 'tag', attrs: { title: tag, targetId: null } });
    });
    children.push({ doc: { type: 'doc', content: [{ type: 'paragraph', content }] } });
  }

  return {
    draft: { id: uuid(), doc, children, cardDirection: !isCloze && hasReverse ? 'both' : 'forward' },
    imageNames,
    tags,
  };
}

/** Our card id for an Anki card, given the rem its note became. */
function cardIdFor(remId: string, card: AnkiCard, isCloze: boolean): string {
  if (isCloze) return `${remId}::cloze:${card.ord + 1}`;
  return card.ord === 1 ? `${remId}::backward` : `${remId}::forward`;
}

function scheduleFrom(card: AnkiCard, collection: AnkiCollection, lastReview: number | null, now: number): Partial<Flashcard> {
  const ease = card.factor > 0 ? Math.max(MIN_EASE, card.factor / 1000) : DEFAULT_EASE;
  let dueAt = now;
  if (card.type === 2) dueAt = (collection.crt + card.due * 86_400) * 1000;
  else if (card.type === 1 || card.type === 3) dueAt = card.due * 1000;
  return {
    easeFactor: ease,
    intervalDays: card.ivl > 0 ? card.ivl : 0,
    repetitions: card.type === 2 ? Math.max(2, card.reps - card.lapses) : 0,
    lapses: card.lapses,
    dueAt,
    lastReviewedAt: card.type === 0 ? null : lastReview ?? now,
    suspended: card.queue === -1,
    // FSRS replays a card's history from `createdAt` on; Anki card ids are
    // their creation time, so every imported review counts.
    createdAt: Math.min(Number(card.id), now),
    updatedAt: now,
  };
}

function stateFor(review: AnkiReview, isFirst: boolean): ReviewState {
  if (review.type === 0) return isFirst ? 'new' : 'learning';
  if (review.type === 2) return 'relearning';
  return 'review';
}

function reviewsFor(ourCardId: string, remId: string, kind: Flashcard['kind'], history: AnkiReview[]): ReviewLogEntry[] {
  const out: ReviewLogEntry[] = [];
  let previous: number | null = null;
  let lapses = 0;
  let repetitions = 0;
  for (const review of history) {
    // Manual reschedules and "set due date" rows aren't reviews.
    if (review.ease === 0 || review.type >= 4) continue;
    const grade = qualityForEase(review.ease);
    const ease = review.factor > 0 ? review.factor / 1000 : DEFAULT_EASE;
    out.push({
      id: uuid(),
      cardId: ourCardId,
      nodeId: remId,
      kind,
      grade,
      reviewedAt: review.id,
      scheduledFor: review.id,
      elapsedMs: previous === null ? null : review.id - previous,
      state: stateFor(review, previous === null),
      intervalBefore: review.lastIvl > 0 ? review.lastIvl : 0,
      intervalAfter: review.ivl > 0 ? review.ivl : 0,
      easeBefore: ease,
      easeAfter: ease,
      repetitionsBefore: repetitions,
      lapsesBefore: lapses,
      deletedAt: null,
      createdAt: review.id,
      updatedAt: review.id,
    });
    if (grade < 3) {
      if (review.type === 1) lapses += 1;
      repetitions = 0;
    } else {
      repetitions += 1;
    }
    previous = review.id;
  }
  return out;
}

export async function importAnkiCollection(collection: AnkiCollection, now = Date.now()): Promise<AnkiImportReport> {
  const cardsByNote = new Map<string, AnkiCard[]>();
  for (const card of collection.cards) {
    const list = cardsByNote.get(card.noteId) ?? [];
    list.push(card);
    cardsByNote.set(card.noteId, list);
  }
  const reviewsByCard = new Map<string, AnkiReview[]>();
  for (const review of collection.reviews) {
    const list = reviewsByCard.get(review.cardId) ?? [];
    list.push(review);
    reviewsByCard.set(review.cardId, list);
  }

  // Deck tree: top-level decks become pages, deeper levels heading rems.
  interface DeckNode {
    name: string;
    notes: DraftRem[];
    children: Map<string, DeckNode>;
  }
  const roots = new Map<string, DeckNode>();
  const deckNode = (path: string[]): DeckNode => {
    let level = roots;
    let node: DeckNode | undefined;
    for (const part of path) {
      node = level.get(part);
      if (!node) {
        node = { name: part, notes: [], children: new Map() };
        level.set(part, node);
      }
      level = node.children;
    }
    return node!;
  };

  const built: Array<{ note: AnkiNote; remId: string; isCloze: boolean; cards: AnkiCard[] }> = [];
  const allImages = new Set<string>();
  const allTags = new Set<string>();
  let skippedNotes = 0;

  for (const note of collection.notes) {
    const cards = cardsByNote.get(note.id) ?? [];
    const type = collection.noteTypes.get(note.noteTypeId);
    if (cards.length === 0 || !type) {
      skippedNotes += 1;
      continue;
    }
    const isCloze = type.isCloze || note.fields.some((f) => /\{\{c\d+::/.test(f));
    const { draft, imageNames, tags } = noteToDraft(note, isCloze, type.fieldNames, cards.some((c) => c.ord === 1));
    imageNames.forEach((n) => allImages.add(n));
    tags.forEach((t) => allTags.add(t));
    const path = collection.decks.get(cards[0]!.deckId) ?? ['Imported'];
    deckNode(path).notes.push(draft);
    built.push({ note, remId: draft.id!, isCloze, cards });
  }

  // Images: store each once, then point every placeholder at it.
  const imageIds = new Map<string, string>();
  let images = 0;
  for (const name of allImages) {
    const bytes = collection.media.get(name);
    if (!bytes) continue;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    try {
      const stored = await storeImage(new Blob([bytes.slice()], { type: MIME[ext] ?? 'image/png' }));
      imageIds.set(name, stored.id);
      images += 1;
    } catch {
      // Left as a note below.
    }
  }
  const fixImages = (node: DocNode): DocNode => {
    if (node.type === 'remImage' && typeof node.attrs?.src === 'string') {
      const id = imageIds.get(node.attrs.src);
      return id
        ? { type: 'remImage', attrs: { imageId: id, alt: '', size: 'full' } }
        : docFromText(`[image: ${node.attrs.src}]`).content![0]!;
    }
    return node.content ? { ...node, content: node.content.map(fixImages) } : node;
  };
  const fixDrafts = (drafts: DraftRem[]) => {
    for (const d of drafts) {
      d.doc = fixImages(d.doc);
      fixDrafts(d.children ?? []);
    }
  };

  const toDrafts = (node: DeckNode, level: number): DraftRem[] => [
    ...node.notes,
    ...[...node.children.values()].map((child) => ({
      doc: { type: 'doc', content: [{ type: 'heading', attrs: { level: Math.min(level, 6) }, content: [{ type: 'text', text: child.name }] }] },
      collapsed: false,
      children: toDrafts(child, level + 1),
    })),
  ];

  const folder = await ensureFolderNamed('Anki');
  const pages: DraftPage[] = [];
  for (const root of roots.values()) {
    // Anki's "Default" deck, when empty, is noise.
    if (root.name === 'Default' && root.notes.length === 0 && root.children.size === 0) continue;
    const drafts = toDrafts(root, 2);
    fixDrafts(drafts);
    pages.push({ title: docFromText(root.name), drafts, folderId: folder.id });
  }

  const newTags: string[] = [];
  for (const tag of allTags) {
    if ((await findTagPages(tag)).length === 0 && !newTags.some((t) => t.toLowerCase() === tag.toLowerCase())) newTags.push(tag);
  }
  if (newTags.length > 0) {
    const tagsFolder = await ensureFolderNamed(TAGS_FOLDER_NAME);
    for (const tag of newTags) pages.push({ title: docFromText(tag), drafts: [], folderId: tagsFolder.id });
  }

  // Creating the rems makes their cards (reconcileCards); now give those
  // cards Anki's schedule, and the log Anki's history.
  await createPagesWithTrees(pages);

  const cardUpdates: Flashcard[] = [];
  const logRows: ReviewLogEntry[] = [];
  for (const { remId, isCloze, cards } of built) {
    for (const card of cards) {
      const ourId = cardIdFor(remId, card, isCloze);
      const existing = await db.cards.get(ourId);
      if (!existing) continue;
      const history = reviewsByCard.get(card.id) ?? [];
      const last = history.filter((r) => r.ease > 0).at(-1)?.id ?? null;
      cardUpdates.push({ ...existing, ...scheduleFrom(card, collection, last, now) });
      logRows.push(...reviewsFor(ourId, remId, existing.kind, history));
    }
  }
  await db.transaction('rw', db.cards, db.reviews, async () => {
    await db.cards.bulkPut(cardUpdates);
    await db.reviews.bulkAdd(logRows);
  });

  return {
    decks: pages.length - newTags.length,
    notes: built.length,
    cards: cardUpdates.length,
    reviews: logRows.length,
    images,
    skippedNotes,
  };
}

/** Load sql.js (and its wasm) only when someone actually imports a deck. */
async function loadSql(): Promise<SqlJsStatic> {
  const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
    import('sql.js'),
    import('sql.js/dist/sql-wasm.wasm?url'),
  ]);
  return initSqlJs({ locateFile: () => wasmUrl });
}

export async function importApkg(file: Blob, sql?: SqlJsStatic): Promise<AnkiImportReport> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const collection = readApkg(bytes, sql ?? (await loadSql()));
  return importAnkiCollection(collection);
}

