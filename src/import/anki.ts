import { unzipSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';
import type { Database, SqlJsStatic } from 'sql.js';

/**
 * Reading an Anki `.apkg`.
 *
 * An `.apkg` is a zip holding a SQLite collection and numbered media files.
 * Three generations are handled:
 *
 * - `collection.anki2` / `collection.anki21` — plain SQLite, note types and
 *   decks as JSON blobs in the `col` row (Anki before 2.1.50, or any export
 *   with "support older Anki versions" ticked);
 * - `collection.anki21b` — the same data zstd-compressed, with note types,
 *   fields, templates and decks in tables of their own (schema 18), and the
 *   media index as zstd-compressed protobuf. Modern exports also carry a
 *   decoy `collection.anki2` whose one note says "please update Anki"; that
 *   is why the newest collection present always wins.
 *
 * This module only *reads*; `importAnki.ts` decides what the notes become.
 */

export interface AnkiNoteType {
  id: string;
  name: string;
  isCloze: boolean;
  fieldNames: string[];
}

export interface AnkiNote {
  id: string;
  noteTypeId: string;
  fields: string[];
  tags: string[];
}

export interface AnkiCard {
  id: string;
  noteId: string;
  deckId: string;
  ord: number;
  /** 0 new, 1 learning, 2 review, 3 relearning. */
  type: number;
  /** -1 suspended, -2/-3 buried, otherwise the type's queue. */
  queue: number;
  due: number;
  /** Days when positive; negative values are seconds (learning steps). */
  ivl: number;
  /** Ease in permille (2500 = 2.5). */
  factor: number;
  reps: number;
  lapses: number;
}

export interface AnkiReview {
  /** Milliseconds since the epoch — the revlog's id is the review time. */
  id: number;
  cardId: string;
  /** 1 again … 4 easy; 0 for manual rescheduling rows. */
  ease: number;
  ivl: number;
  lastIvl: number;
  factor: number;
  /** 0 learn, 1 review, 2 relearn, 3 filtered, 4 manual, 5 rescheduled. */
  type: number;
}

export interface AnkiCollection {
  /** Collection creation, seconds — review due dates are days from here. */
  crt: number;
  /** Deck id → its path (`["Biology", "Cells"]`). */
  decks: Map<string, string[]>;
  noteTypes: Map<string, AnkiNoteType>;
  notes: AnkiNote[];
  cards: AnkiCard[];
  reviews: AnkiReview[];
  /** File name as fields refer to it → bytes. */
  media: Map<string, Uint8Array>;
}

export class AnkiFormatError extends Error {}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function isZstd(bytes: Uint8Array): boolean {
  return ZSTD_MAGIC.every((b, i) => bytes[i] === b);
}

function maybeDecompress(bytes: Uint8Array): Uint8Array {
  return isZstd(bytes) ? zstdDecompress(bytes) : bytes;
}

// ------------------------------------------------------------ tiny protobuf

function readVarint(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  let shift = 0;
  let pos = at;
  while (pos < bytes.length) {
    const byte = bytes[pos++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [value, pos];
}

/** The fields of one protobuf message, as (number, wire type, value) triples. */
function readMessage(bytes: Uint8Array): Array<{ field: number; value: number | Uint8Array }> {
  const out: Array<{ field: number; value: number | Uint8Array }> = [];
  let pos = 0;
  while (pos < bytes.length) {
    const [key, afterKey] = readVarint(bytes, pos);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    pos = afterKey;
    if (wire === 0) {
      const [value, next] = readVarint(bytes, pos);
      out.push({ field, value });
      pos = next;
    } else if (wire === 2) {
      const [length, next] = readVarint(bytes, pos);
      out.push({ field, value: bytes.subarray(next, next + length) });
      pos = next + length;
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      break;
    }
  }
  return out;
}

/**
 * The modern media index: `MediaEntries { repeated MediaEntry entries = 1 }`,
 * `MediaEntry { string name = 1; uint32 size = 2; bytes sha1 = 3; }`. The
 * entry's position is its file name in the zip.
 */
function readMediaIndex(bytes: Uint8Array): Map<string, string> {
  const map = new Map<string, string>();
  const decoder = new TextDecoder();
  readMessage(bytes)
    .filter((f) => f.field === 1 && f.value instanceof Uint8Array)
    .forEach((entry, index) => {
      const name = readMessage(entry.value as Uint8Array).find((f) => f.field === 1);
      if (name && name.value instanceof Uint8Array) map.set(String(index), decoder.decode(name.value));
    });
  return map;
}

// ------------------------------------------------------------------ sqlite

function rows<T>(db: Database, sql: string): T[] {
  const result = db.exec(sql);
  if (result.length === 0) return [];
  const { columns, values } = result[0]!;
  return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])) as T);
}

function hasTable(db: Database, name: string): boolean {
  return rows<{ n: number }>(db, `select count(*) as n from sqlite_master where type='table' and name='${name}'`)[0]?.n === 1;
}

const latin1 = new TextDecoder('latin1');

function readNoteTypes(db: Database): Map<string, AnkiNoteType> {
  const types = new Map<string, AnkiNoteType>();
  if (hasTable(db, 'notetypes')) {
    for (const nt of rows<{ id: number | string; name: string }>(db, 'select id, name from notetypes')) {
      types.set(String(nt.id), { id: String(nt.id), name: nt.name, isCloze: false, fieldNames: [] });
    }
    for (const f of rows<{ ntid: number | string; ord: number; name: string }>(db, 'select ntid, ord, name from fields order by ntid, ord')) {
      types.get(String(f.ntid))?.fieldNames.push(f.name);
    }
    // The note type's kind lives in a protobuf config; the templates say it
    // just as plainly — a cloze type's front is `{{cloze:Field}}`.
    for (const t of rows<{ ntid: number | string; config: Uint8Array }>(db, 'select ntid, config from templates')) {
      if (latin1.decode(t.config).includes('{{cloze:')) {
        const type = types.get(String(t.ntid));
        if (type) type.isCloze = true;
      }
    }
    return types;
  }

  const [col] = rows<{ models: string }>(db, 'select models from col');
  const models = JSON.parse(col?.models ?? '{}') as Record<string, { name: string; type: number; flds: Array<{ name: string; ord: number }> }>;
  for (const [id, model] of Object.entries(models)) {
    types.set(id, {
      id,
      name: model.name,
      isCloze: model.type === 1,
      fieldNames: [...model.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
    });
  }
  return types;
}

function readDecks(db: Database): Map<string, string[]> {
  const decks = new Map<string, string[]>();
  if (hasTable(db, 'decks')) {
    for (const d of rows<{ id: number | string; name: string }>(db, 'select id, name from decks')) {
      // Schema 18 separates levels with \x1f rather than "::".
      decks.set(String(d.id), d.name.split(/\x1f|::/));
    }
    return decks;
  }
  const [col] = rows<{ decks: string }>(db, 'select decks from col');
  const json = JSON.parse(col?.decks ?? '{}') as Record<string, { name: string }>;
  for (const [id, deck] of Object.entries(json)) decks.set(id, deck.name.split('::'));
  return decks;
}

/** Open an `.apkg`. `SQL` is an initialised sql.js — passed in so the wasm is only fetched when importing. */
export function readApkg(bytes: Uint8Array, SQL: SqlJsStatic): AnkiCollection {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new AnkiFormatError("That file isn't an Anki package (.apkg) — it couldn't be unzipped.");
  }

  const collectionBytes =
    files['collection.anki21b'] ? zstdDecompress(files['collection.anki21b']) : files['collection.anki21'] ?? files['collection.anki2'];
  if (!collectionBytes) throw new AnkiFormatError('That package has no Anki collection in it.');

  const db = new SQL.Database(collectionBytes);
  try {
    const [col] = rows<{ crt: number }>(db, 'select crt from col');
    const notes = rows<{ id: number | string; mid: number | string; flds: string; tags: string }>(db, 'select id, mid, flds, tags from notes').map(
      (n): AnkiNote => ({
        id: String(n.id),
        noteTypeId: String(n.mid),
        fields: n.flds.split('\x1f'),
        tags: n.tags.trim() ? n.tags.trim().split(/\s+/) : [],
      })
    );
    if (notes.length === 1 && /please update to the latest anki/i.test(notes[0]!.fields[0] ?? '')) {
      throw new AnkiFormatError('That package needs a newer reader than it found — please report it.');
    }

    const cards = rows<Record<string, number | string>>(
      db,
      'select id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses from cards'
    ).map(
      (c): AnkiCard => ({
        id: String(c.id),
        noteId: String(c.nid),
        deckId: String(c.did),
        ord: Number(c.ord),
        type: Number(c.type),
        queue: Number(c.queue),
        due: Number(c.due),
        ivl: Number(c.ivl),
        factor: Number(c.factor),
        reps: Number(c.reps),
        lapses: Number(c.lapses),
      })
    );

    const reviews = rows<Record<string, number | string>>(
      db,
      'select id, cid, ease, ivl, lastIvl, factor, type from revlog order by id'
    ).map(
      (r): AnkiReview => ({
        id: Number(r.id),
        cardId: String(r.cid),
        ease: Number(r.ease),
        ivl: Number(r.ivl),
        lastIvl: Number(r.lastIvl),
        factor: Number(r.factor),
        type: Number(r.type),
      })
    );

    // Media: a JSON index in older packages, zstd protobuf in newer ones.
    const media = new Map<string, Uint8Array>();
    const rawIndex = files['media'];
    if (rawIndex && rawIndex.length > 0) {
      const index = maybeDecompress(rawIndex);
      let names: Map<string, string>;
      if (index[0] === 0x7b /* { */) {
        names = new Map(Object.entries(JSON.parse(new TextDecoder().decode(index)) as Record<string, string>));
      } else {
        names = readMediaIndex(index);
      }
      for (const [zipName, fileName] of names) {
        const data = files[zipName];
        if (data) media.set(fileName, maybeDecompress(data));
      }
    }

    return {
      crt: Number(col?.crt ?? 0),
      decks: readDecks(db),
      noteTypes: readNoteTypes(db),
      notes,
      cards,
      reviews,
      media,
    };
  } finally {
    db.close();
  }
}
