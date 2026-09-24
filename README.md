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

### Offline and installable

The built app (`npm run build`, or the GitHub Pages deploy) registers a service
worker that caches the whole app on first visit, so it opens with no connection
at all — your notes were already local. Browsers that support it offer
**Install** in the address bar, giving Clemnotes its own window and icon. A new
deploy is picked up on the next visit. (The dev server doesn't register the
worker, so `npm run dev` always serves fresh code.)

## Writing

### Structure

- `Enter` — new sibling rem. In a page title (or the top row of a rem you've
  zoomed into) it drops down into the first bullet instead of starting a new
  page — reusing that bullet if it's already there, creating it if it isn't
- `Tab` / `Shift+Tab` — indent / outdent
- `↑` / `↓` on the first or last line of a rem — go to the rem above or below
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

**Shift-click** a link (or a page in the sidebar) to open it **beside** the one
you're on, in a second pane — a source on one side and your own notes on the
other. `◫` in the top bar opens or closes the pane, `⇄` swaps the two, and links
clicked inside the side pane navigate that pane. Both panes are the same live
outline, so a rem open in both updates in both. The pair is part of the URL, so
back, forward and reload keep it.

The `⧈` button on a row (or `/embed`) inserts a **portal**: a live, editable view
of another rem's subtree. It isn't a copy — edits inside the embed write straight
back to the original.

A rem can't embed itself or anything it already sits inside; the picker says so
rather than creating it. Cycles that only exist between portals — A embeds B
while B embeds A — are caught while rendering instead: the inner embed shows a
short note and its `↗` jump link rather than opening a copy of something already
on screen.

### Tags

Type `#` and a word and a picker offers existing pages, or "Create #word" for a
new one. A tag is a small green chip; clicking it opens the tag's page, which
lists everything tagged with it under **Tagged**, separately from ordinary
**Linked References**. New tag pages are filed in a **Tags** folder, but any
page can be a tag. A saved query (`/query`) can filter by tag too.

`#` only starts a tag at the beginning of a word, so `C#`, URL fragments and the
`# ` heading shortcut are left alone.

### Daily notes

**Today** in the sidebar (or `Alt+Shift+D`) opens a page for today's date,
titled `2026-09-23`, making it the first time and filing it under **Daily
notes**. A bar above the title shows the day in words and steps to the day
before or after. `[[2026-09-23]]` links to that day's note, and typing
`[[today`, `[[yesterday` or `[[tomorrow` in the link picker offers the date.

### Images

Paste or drop an image into any rem, or use `/image` to pick a file. Hover an
image for S / M / L sizes and a full-size view. Images are stored in this
browser (IndexedDB), so they work offline; very large photos are shrunk to
2400 px on their longest side first. With cloud sync on, they are uploaded to a
private Supabase Storage bucket and other devices fetch each one the first time
they show it — see `migration-005-images.sql` below.

### Templates

Any page in the **Templates** folder is a template. Type `/template` in a rem to
stamp a copy of one in (replacing the empty bullet you typed it into); the
picker's **+ New template** makes one. `%date%`, `%time%` and `%weekday%` are
filled in on the way.

### Finding things

`⌘K` searches everything; `⌘⇧F` finds in the page you're on and puts the cursor
on the match (unfolding anything collapsed above it). Both have **Everywhere /
This page** (Tab switches), **Has cards** and **Edited this week** filters.

Every rem shows **Linked References** and, folded underneath, **Unlinked
references**: rems that mention it by name without linking to it, each with a
**Link** button.

### Version history

`⟲` on a rem (or in the top bar, for the page you're zoomed into) lists its past
versions — one is kept whenever you come back to edit it after ten minutes — with
a preview and **Restore**. Restoring keeps the current text as a version first.
History is kept on this device only. When cloud sync can't combine edits made to
the same rem on two devices (see *How sync works*), the newer one wins but the
other goes into history and the sidebar points at it.

### Long documents

A rem is drawn as plain text until you click into it, and only then becomes an
editor — so a page of hundreds of rems opens quickly and stays light. Nothing
about using it changes: the cursor lands where you clicked (a double-click
selects the word), links and tags work straight away, and clicking a formula,
a defined word, a to-do box or an image's size buttons does what it always did.
A 400-rem page that used to build 401 editors now builds none until you click;
it reloads about four times faster and uses about a quarter of the memory.

### Layout

Drag the sidebar's edge to resize it (double-click to reset). `☾ / ☀ / ◐` beside
the logo switches dark, light and system themes. The top bar shows the word count
for what you're looking at, `☰` lists its headings, and `◎` (`Alt+Shift+F`) is
focus mode, which dims everything but the rem you're writing.

### Accessibility

The outline is exposed to screen readers as a tree: each rem is an item with
its level, whether it is folded, and whether it is selected, named by its own
text rather than everything underneath it. Every icon button has a name,
keyboard focus is always visible, hover-only controls also appear when a
keyboard reaches them, and zooming moves focus to the new page rather than
dropping it. With "reduce motion" set in your system, animations are off.

### Maths

Type `$e=mc^2$` and the closing `$` renders it as live KaTeX. Click a formula to
edit its LaTeX.

## Flashcards

Four ways to make a card, all just text in a normal rem:

- **`Concept :: Descriptor`** — everything before the `::` is the question,
  everything after is the answer. The badge on the row toggles between a one-way
  card and a two-way pair that also tests the reverse direction.
- **`Question ::`** with nothing after it — the rem's children are the answer,
  for answers that don't fit on one line. It is the same card as `A :: B`, so
  typing an answer onto the line later keeps its schedule.
- **`Prompt >>>`** — a list card: "name everything underneath". The answer is
  the rem's children, numbered, read at review time — add an item and the card
  changes without being reset.
- **`{{cloze blanks}}`** — each pair of braces becomes its own numbered blank,
  so one sentence can test several facts independently. Selecting text and
  hitting `⌷` in the formatting toolbar does the same thing.

The **Flashcards** tab shows what's due and runs the review session: `Space`
reveals the answer, then `1`–`4` (or the buttons) grade it Again / Hard / Good /
Easy, with the resulting interval shown on each button.

Scheduling is **FSRS** by default: it models how quickly you forget each card
from its review history and schedules the next review for when recall is predicted
to fall to your **desired recall** (90% unless you change it). Memory state isn't
stored — it's replayed from the review log — so cards you reviewed under SM-2
carried their real history across, and **Fit to my reviews** (once you have 200
reviews spaced a day or more apart) tunes FSRS to you. **SM-2** is still one
setting away.

Under SM-2, the algorithm behind SuperMemo and classic Anki, each card
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

## Importing

**Sidebar → Export & backup → Import from elsewhere.**

- **Markdown files** or **a folder / Obsidian vault**: headings nest what's under
  them, list items become rems, `[[links]]` between the imported notes resolve,
  `#tags` get tag pages, `{{clozes}}` and `::` make cards, and images the notes
  refer to are imported from the folder. Clemnotes' own Markdown export reads back
  as the pages it wrote. Everything lands in one folder named after the import.
- **Anki deck (.apkg)**, current or older format: decks become pages (sub-decks as
  headings), Basic notes become `Front :: Back` (two-way when there's a reverse
  card), Cloze notes keep their numbered blanks, and extra fields, tags and images
  come along. Each card keeps its interval, ease, due date and suspension, and
  every past review goes into the review log, so FSRS schedules imported cards from
  their real history.

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

Worth doing before any risky change.

**Maintenance** (same panel):

- **Clean up unused images** — finds images no rem, deleted rem or saved version
  still refers to, says how many and how much space, and removes them here and
  from cloud Storage. Anything added in the last seven days is left alone, so an
  image you've just cut and are about to paste back is safe.
- **Diagnostics…** — the last 300 things the app did in the background: syncs
  and what they moved, merged edits and conflicts, upgrades and their snapshots,
  imports, image uploads, and any error. It never records note text, so **Copy**
  gives you something safe to paste into a bug report. The "Something went wrong"
  screen includes it in its copied details too.

**Schema upgrades back themselves up.** Before a new version of the app
upgrades the database, it copies every table into a separate IndexedDB database
(`clemnotes-migration-snapshots`), keeping the last three. They are listed under
**Export & backup → Saved before upgrades**, and each downloads as an ordinary
backup file. If that copy can't be written (a full disk, say), the app stops
before upgrading and offers the backup as a download first.

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
| only `nodes` | `supabase/migration-002-sync-all.sql`, then `003`, `004` and `005` |
| everything except `reviews` | `supabase/migration-003-reviews.sql`, then `004` and `005` |
| everything, no images yet | `supabase/migration-005-images.sql` (creates the private `images` bucket) |

`migration-004-sync-watermarks.sql` only adds indexes; nothing breaks without it.

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

`.env` is gitignored. Replace both values with your own — if either is still
the template, missing, or doesn't look like a Supabase URL or key, the sidebar
says which one instead of showing a sign-in form that can only fail.

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
- **Engine** (`src/sync/syncEngine.ts`): a two-way merge by `updatedAt`, run
  independently over each table. It fires right after sign-in, every 20 seconds
  while signed in, whenever the tab regains focus, and on demand.
- **Rems merge field by field.** Each device remembers the last version of every
  rem it agreed on with the cloud. When both sides changed a rem since then, the
  changes are combined: move a bullet on your laptop and edit its text on your
  phone and you keep both. Only when the *text itself* was edited on both sides
  does one win — the newer — with the other kept in version history. The other
  tables are still last-write-wins per row.
- **`reviews` syncs differently.** Its rows are written once and never touched
  again, so there is nothing to compare: the poll fetches only the remote's ids
  and pulls full rows for the ones it's missing. That matters because it's the
  one table with no ceiling on its size — it grows even on days you write
  nothing — and the general merge downloads every row on every poll.
- **Deletes**: everything is soft-deleted (a `deletedAt` timestamp rather than
  removing the row), so a deletion is just another field change travelling
  through the same merge — no risk of a device that hasn't seen the delete
  resurrecting the row.
- **Old deletions are purged after 90 days.** During the daily full sync the
  cloud drops deleted rows older than that, and each device follows. A device
  that was offline long enough to miss both the delete and the purge deletes
  its copy too, rather than uploading it again — unless you edited it there in
  the meantime, in which case your edit wins and it comes back. A notebook
  without sync purges its own old deletions.
- **Partial failure is survivable**: one table failing (a missing migration, say)
  doesn't abandon the others.

### Known limitations

- **Text isn't merged within a rem.** Edit the *words* of the same bullet on two
  devices while both are offline and the newer edit wins — the other is kept in
  that rem's version history and flagged in the sidebar, rather than lost.
  (Different fields — position, collapsed state, the text — do combine.) The
  record of what was last agreed lives on each device, so the first sync after
  this update, or on a new device, falls back to newest-wins until it has one.
- **No realtime push.** Sync polls (20s + on focus + on demand) rather than
  holding a live Supabase realtime channel. Good enough for "laptop now, phone
  later"; not simultaneous multi-device editing.
- **A device that last synced on an older version of the app, and then stayed
  offline for more than 90 days**, can bring back a rem that was deleted and
  purged meanwhile: it has no record of having agreed on that rem with the
  cloud, so it can't tell "purged" from "never uploaded". Once a device has
  synced on this version, it can.
- **Backspace-merging two rems collapses to plain text.** Structurally merging
  two rich-text documents is a nontrivial ProseMirror operation; merges still
  work, they just lose formatting on the row being merged in.
- **Unused images stay until you clean them up.** Removing an image from a rem
  leaves its bytes in place (so undo works); **Clean up unused images** clears
  them. It runs per device — another device still holding an image it uploaded
  itself is unaffected.
- **Image upload to Supabase Storage hasn't been run against a live project
  yet.** It uses the documented storage API and fails soft — images keep working
  on the device they were added on — but it is the one part of this that is
  untested end to end.

## Deploying to GitHub Pages

1. Push to GitHub.
2. `vite.config.ts` sets `base` to `/clemnotes/` when `GITHUB_PAGES=true` —
   update that string if you rename the repo.
3. Repo settings → **Pages → Source: GitHub Actions**.
4. Push to `main`; the workflow in `.github/workflows/deploy.yml` builds and
   deploys.

The workflow fails if the JavaScript needed to open the app grows past the budget
in `scripts/bundle-budget.json` (340 kB gzipped; it is about 313 kB). Run
`npm run build && npm run check:bundle` to see the numbers locally. The
flashcard and definitions views and the Supabase client load on demand, so they
don't count toward it.

## Project structure

```
src/
  db/
    schema.ts              # OutlinerNode, Flashcard, ReviewLogEntry, DictionaryEntry, PageFolder
    database.ts            # Dexie definition + v1→v15 migrations, the row normaliser every write goes through
    migrationSafety.ts     # the pre-upgrade snapshot, and the list of them
    versionRepository.ts   # version history, and conflict copies from sync
    treeInsert.ts          # inserting whole trees (templates, imports) in one go
    tombstones.ts          # purging deletions older than 90 days
    templates.ts           # /template
    unlinked.ts            # unlinked references
    outline.ts             # word count, table of contents
    dailyNotes.ts          # a page per date
    tags.ts                # #tags: tag pages, the picker's search, tag matching
    imageRepository.ts     # image bytes in IndexedDB, shrinking big photos, the unused-image sweep
    repository.ts          # all rem CRUD: create, indent, outdent, move, merge, links
    cardRepository.ts      # deriving and scheduling flashcards from rem content
    reviewRepository.ts    # the append-only review log + its read helpers
    dictionaryRepository.ts
    folderRepository.ts
    searchIndex.ts         # FlexSearch index for the ⌘K omnibar
  srs/
    sm2.ts                 # SM-2, pure functions
    fsrs.ts                # FSRS: replay from the log, scheduling, fitting
  tiptap/
    extensions.ts          # the shared editor extension set
    docUtils.ts            # doc parsing, plain-text extraction, card splitting
    WikiLinkNode.tsx       # [[links]]
    MathNode.tsx           # $LaTeX$
    ClozeNode.tsx          # {{blanks}}
    TagNode.tsx            # #tags
    ImageNode.tsx          # pasted / dropped images
    cardFaces.ts           # what each kind of card shows on each side
    StaticDoc.tsx          # a rem drawn without an editor, identical to the editor's markup
    DictionaryHighlight.ts # definition underlines + tooltips
    dictionaryMatcher.ts   # every definition compiled into one regex
    FontSize.ts
  editor/
    menuStore.ts           # lets popup menus claim keys from the focused editor
  components/
    OutlinerNode.tsx       # the recursive rem row
    RemText.tsx            # a rem's text: static until clicked, then a live editor
    EditorMenus.tsx        # the / and [[ popups
    FormattingBubble.tsx   # the selection toolbar
    ReviewView.tsx         # the flashcard session
    SplitPane.tsx          # the second document, beside the first
    DiagnosticsPanel.tsx   # the event log, with Copy
    PageSidebar.tsx, SearchOmnibar.tsx, BacklinksPanel.tsx, …
  import/
    inline.ts, markdown.ts # Markdown → rems
    importMarkdown.ts      # files / folders, images, tag pages
    anki.ts                # reading .apkg (legacy and anki21b)
    ankiHtml.ts            # Anki field HTML → inline content
    importAnki.ts          # notes → rems, schedules and review history
  export/
    backup.ts              # the lossless JSON envelope
    importBackup.ts        # parsing, validation and the merge on restore
    markdown.ts            # rendering rems to readable Markdown
    tree.ts                # one consistent snapshot of the page trees
    download.ts            # the only part that touches the DOM
  sync/
    syncEngine.ts          # table-agnostic two-way sync
    merge.ts               # field-level three-way merge
    nodeMerge.ts           # rem conflicts: merge, or keep the loser in history
    imageSync.ts           # image bytes to and from Supabase Storage
    syncConfig.ts          # catching template / half-set env vars
    supabaseClient.ts      # loads supabase-js on demand
  diagnostics.ts           # the rolling event log
scripts/
  service-worker.ts        # Vite plugin that writes sw.js (offline cache)
  check-bundle.mjs         # the startup-size budget, run in CI
  verify-export.ts         # end-to-end export/import/review-log check, run in Node
supabase/
  schema.sql                     # fresh install
  migration-002-sync-all.sql     # upgrade from the notes-only schema
  migration-003-reviews.sql      # adds the review log
  migration-004-sync-watermarks.sql  # indexes for incremental sync
  migration-005-images.sql       # the private images bucket
```

## Tests

```bash
npm test          # Vitest, against fake-indexeddb
npx tsc -b        # type check
npm run lint      # oxlint
```

The data layer — repository, sync merge, import, export, scheduling, migrations —
is covered by unit tests that run the real Dexie code against an in-memory
IndexedDB. `scripts/verify-export.ts` is the older end-to-end export check and
still runs standalone.

## What's not built

PDF reading, touch-friendly dragging and a phone layout. The full list, with what is done, is in the roadmap.
