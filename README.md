# Clemnotes

A local-first, infinite-nesting outliner with bidirectional links, spaced-repetition
flashcards and optional cloud sync. Everything is a *rem*: a page, a bullet, a
flashcard and an embed are all the same kind of node, just used differently.

## Running locally

```bash
npm install
npm run dev
```

Open the printed localhost URL. With no configuration the app is entirely local —
data lives in your browser's IndexedDB (via Dexie), persists across reloads, and
never leaves the machine. Cloud sync is opt-in; see below.

## Writing

### Structure

- `Enter` — new sibling rem. In a page title (or the top row of a rem you've
  zoomed into) it drops down into the first bullet instead of starting a new
  page — reusing that bullet if it's already there, creating it if it isn't
- `Tab` / `Shift+Tab` — indent / outdent
- `Alt+↑` / `Alt+↓` — move a rem (and its whole subtree) among its siblings
- `Backspace` at the start of an empty rem — merge into the previous one
- Drag the `⠿` handle to move a rem anywhere: drop near a row's top or bottom
  edge to reorder, or in the middle of it to nest underneath
- Click any bullet to zoom into it; the breadcrumb above walks back out
- `⌘K` / `Ctrl+K` — search every rem in the app
- `⌘\` / `Ctrl+\` — show/hide the sidebar

### The `/` menu

Type `/` anywhere for headings, to-dos, tables, code blocks, quotes, dividers,
math, bullet and numbered lists, embeds, links and flashcards. Arrow keys to
move, `Enter` to pick, `Escape` to dismiss.

### Formatting

Select text and a toolbar appears over it: heading level, bold/italic/underline/
strikethrough/code, highlight and text colours, font family and size, alignment,
and a button to turn the selection into a cloze blank. The Markdown shortcuts
(`**bold**`, `*italic*`, `` `code` ``, ` ``` ` for a code block) all work while
typing, as do `⌘B` / `⌘I` / `⌘U`.

### Links and embeds

Type `[[` and a live picker searches every rem as you type — arrow keys and
`Enter` to insert, or pick "Create …" to make a new page on the spot. Links
resolve to *any* rem, not just top-level pages, so you can link straight to one
bullet buried in another document. Every zoomed-in rem shows a **Linked
References** panel listing everything that points at it.

The `⧈` button on a row (or `/embed`) inserts a **portal**: a live, editable view
of another rem's subtree. It isn't a copy — edits inside the embed write straight
back to the original.

A rem can't embed itself or anything it already sits inside; the picker says so
rather than creating it. Cycles that only exist between portals — A embeds B
while B embeds A — are caught while rendering instead: the inner embed shows a
short note and its `↗` jump link rather than opening a copy of something already
on screen.

### Maths

Type `$e=mc^2$` and the closing `$` renders it as live KaTeX. Click a formula to
edit its LaTeX.

## Flashcards

Two ways to make a card, both just text in a normal rem:

- **`Concept :: Descriptor`** — everything before the `::` is the question,
  everything after is the answer. The badge on the row toggles between a one-way
  card and a two-way pair that also tests the reverse direction.
- **`{{cloze blanks}}`** — each pair of braces becomes its own numbered blank,
  so one sentence can test several facts independently. Selecting text and
  hitting `⌷` in the formatting toolbar does the same thing.

The **Flashcards** tab shows what's due and runs the review session: `Space`
reveals the answer, then `1`–`4` (or the buttons) grade it Again / Hard / Good /
Easy, with the resulting interval shown on each button.

Scheduling is **SM-2**, the algorithm behind SuperMemo and Anki: each card
carries an ease factor and an interval, a good answer multiplies the interval by
the ease, and a failure resets the streak and puts the card back in the same
session. Two deliberate refinements on textbook SM-2: a forgotten card returns in
ten minutes rather than a full day, and a brand-new card answered "Easy"
graduates straight to four days instead of one.

Cards are derived from rem content and reconciled on every edit. Their IDs are
deterministic (`<remId>::forward`, `<remId>::cloze:2`), so deleting a `::` and
undoing it gets the card's scheduling history back rather than starting over.

Suspending a card mid-session takes it out of the queue without grading it — it
keeps whatever schedule it already had, so unsuspending it months later doesn't
find it carrying an interval from a review that never happened.

### Review history

Every grade is written to an append-only `reviews` table: which card, what
grade, when, how late against its due date, and the interval and ease on either
side of the reschedule. Nothing ever updates or deletes a row there.

This exists because card state is lossy. A card records where its schedule
stands now, and the moment you grade it the fact that you graded it is gone —
which forecloses retention rates, due forecasts, leech detection and any future
move to a scheduler like FSRS that fits a memory model to your actual history.
None of that can be backfilled, so the log had to start before the notebook got
any bigger. Resetting a card clears its schedule but not its history.

## Definitions

The **Definitions** tab holds a personal dictionary. Any word you define is
underlined wherever it appears in your notes — hover for the definition, click to
replace the word with it inline, `Shift`-click to jump to the entry and edit it.

## Export and backup

**Sidebar → Export & backup.**

- **Back up everything (`.json`)** — every rem, card, review, definition and
  folder in one file, including soft-deleted rows. Lossless: content is written
  exactly as the database holds it, so a restore reproduces the database rather
  than an approximation of it. Tombstones are included deliberately — dropping
  them would mean a restore resurrects deleted rems on the next sync.
- **Export notes as Markdown** — the readable copy. Every rem becomes a bullet
  at its own depth, `[[links]]` and `{{clozes}}` come out in the syntax that
  would recreate them, `::` cards survive as literal text, maths becomes
  `$latex$`, and portals are written as Obsidian-style `![[embeds]]` rather than
  being inlined. Heading blocks inside a rem flatten to bold, because a Markdown
  heading can't live inside a list item without breaking the list.
- **Restore from a backup** — merges, keeping whichever copy of a row is newer.
  That's the same last-write-wins rule cloud sync uses, on purpose: if importing
  resolved conflicts differently from syncing, restoring on a synced device would
  produce a state neither device agreed on and the next sync would fight it.
  Importing into an empty database is therefore also a full restore.

Worth doing before any risky change — schema migrations especially.

## Cloud sync (Supabase) — setup

Optional. With no configuration the sidebar just says "Cloud sync not
configured" and everything stays local.

### 1. Create a Supabase project

Free at [supabase.com](https://supabase.com) — about a minute.

### 2. Run the schema

**New project:** in Supabase → **SQL Editor → New query**, paste and run
`supabase/schema.sql`. This creates `nodes`, `dictionary`, `folders`, `cards` and
`reviews`, each with row-level security so a user can only ever read or write
their own rows.

**Upgrading from an earlier version:** run the migrations you're missing rather
than `schema.sql`. Both are safe to run more than once, and neither touches your
existing notes.

| You already have | Run |
|---|---|
| only `nodes` | `supabase/migration-002-sync-all.sql`, then `migration-003-reviews.sql` |
| everything except `reviews` | `supabase/migration-003-reviews.sql` |

Until you run the migration the app still syncs your notes fine — the sidebar
tells you which tables are missing rather than failing the whole sync.

### 3. Turn off email confirmation (optional)

Supabase requires confirming your email before sign-in by default. For personal
use you can turn it off under **Authentication → Providers → Email → "Confirm
email"**.

### 4. Get your API keys

**Project Settings → API** — you need the **Project URL** and the **anon/public
key**. Not the service-role key; that one must never appear in frontend code.

### 5. Local development

```bash
cp .env.example .env
```

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

`.env` is gitignored.

### 6. GitHub Pages deployment

The build bakes these values into the bundle, so they need to exist as **GitHub
Actions secrets**. That's fine for an anon/public key — it's designed to be
exposed client-side, since row-level security, not secrecy, is what protects your
data.

In your repo: **Settings → Secrets and variables → Actions → New repository
secret**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The deploy
workflow already reads them.

### How sync works

- **Auth**: email + password via Supabase Auth, from the sidebar.
- **Engine** (`src/sync/syncEngine.ts`): a two-way, last-write-wins merge by
  `updatedAt`, run independently over each table. It fires right after sign-in,
  every 20 seconds while signed in, whenever the tab regains focus, and on demand.
- **`reviews` syncs differently.** Its rows are written once and never touched
  again, so there is nothing to compare: the poll fetches only the remote's ids
  and pulls full rows for the ones it's missing. That matters because it's the
  one table with no ceiling on its size — it grows even on days you write
  nothing — and the general merge downloads every row on every poll.
- **Deletes**: everything is soft-deleted (a `deletedAt` timestamp rather than
  removing the row), so a deletion is just another field change travelling
  through the same merge — no risk of a device that hasn't seen the delete
  resurrecting the row.
- **Partial failure is survivable**: one table failing (a missing migration, say)
  doesn't abandon the others.

### Known limitations

- **Conflict resolution is whole-row last-write-wins, not field-level.** Edit the
  same bullet on two devices while both are offline and the most recently synced
  one wins entirely. Fine for one device at a time; worth knowing.
- **No realtime push.** Sync polls (20s + on focus + on demand) rather than
  holding a live Supabase realtime channel. Good enough for "laptop now, phone
  later"; not simultaneous multi-device editing.
- **Tombstones accumulate forever.** Deleted rows stay as soft-deleted records.
  Not a problem at personal-notes scale, but a periodic purge would be sensible
  if this ever grew.
- **Backspace-merging two rems collapses to plain text.** Structurally merging
  two rich-text documents is a nontrivial ProseMirror operation; merges still
  work, they just lose formatting on the row being merged in.
- **The production bundle is ~1.2 MB** (mostly KaTeX's fonts and the Tiptap/
  ProseMirror engine). Fine for a personal local-first app; code-splitting is
  the fix if load time ever matters.

## Deploying to GitHub Pages

1. Push to GitHub.
2. `vite.config.ts` sets `base` to `/clemnotes/` when `GITHUB_PAGES=true` —
   update that string if you rename the repo.
3. Repo settings → **Pages → Source: GitHub Actions**.
4. Push to `main`; the workflow in `.github/workflows/deploy.yml` builds and
   deploys.

## Project structure

```
src/
  db/
    schema.ts              # OutlinerNode, Flashcard, ReviewLogEntry, DictionaryEntry, PageFolder
    database.ts            # Dexie definition + v1→v9 migrations
    repository.ts          # all rem CRUD: create, indent, outdent, move, merge, links
    cardRepository.ts      # deriving and scheduling flashcards from rem content
    reviewRepository.ts    # the append-only review log + its read helpers
    dictionaryRepository.ts
    folderRepository.ts
    searchIndex.ts         # FlexSearch index for the ⌘K omnibar
  srs/
    sm2.ts                 # the spaced-repetition algorithm, pure functions
  tiptap/
    extensions.ts          # the shared editor extension set
    docUtils.ts            # doc parsing, plain-text extraction, card splitting
    WikiLinkNode.tsx       # [[links]]
    MathNode.tsx           # $LaTeX$
    ClozeNode.tsx          # {{blanks}}
    DictionaryHighlight.ts # definition underlines + tooltips
    FontSize.ts
  editor/
    menuStore.ts           # lets popup menus claim keys from the focused editor
  components/
    OutlinerNode.tsx       # the recursive rem row
    EditorMenus.tsx        # the / and [[ popups
    FormattingBubble.tsx   # the selection toolbar
    ReviewView.tsx         # the flashcard session
    PageSidebar.tsx, SearchOmnibar.tsx, BacklinksPanel.tsx, …
  export/
    backup.ts              # the lossless JSON envelope
    importBackup.ts        # parsing, validation and the merge on restore
    markdown.ts            # rendering rems to readable Markdown
    tree.ts                # one consistent snapshot of the page trees
    download.ts            # the only part that touches the DOM
  sync/
    syncEngine.ts          # table-agnostic last-write-wins merge
    supabaseClient.ts
scripts/
  verify-export.ts         # end-to-end export/import/review-log check, run in Node
supabase/
  schema.sql                     # fresh install
  migration-002-sync-all.sql     # upgrade from the notes-only schema
  migration-003-reviews.sql      # adds the review log
```

## Verifying without a test runner

There's no test framework in the project yet. Where something needed proving,
it was proved by bundling the relevant modules with esbuild and running them
against `fake-indexeddb` in Node — every module under `src/db` and `src/export`
is browser-free apart from the IndexedDB global, so the whole data layer can be
exercised this way:

```bash
npm i --no-save fake-indexeddb esbuild
npx esbuild scripts/verify-export.ts --bundle --platform=node --format=cjs \
  --outfile=/tmp/verify.cjs && node /tmp/verify.cjs
```

That covers the backup round-trip (export → wipe → restore → byte-identical
re-export), merge semantics, rejection of malformed files, what Markdown
preserves, and that grading a card appends exactly one accurate log row.

## What's not built

Image embedding is the one thing from the original roadmap still unimplemented.
