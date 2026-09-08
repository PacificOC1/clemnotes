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

- `Enter` — new sibling rem
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

## Definitions

The **Definitions** tab holds a personal dictionary. Any word you define is
underlined wherever it appears in your notes — hover for the definition, click to
replace the word with it inline, `Shift`-click to jump to the entry and edit it.

## Cloud sync (Supabase) — setup

Optional. With no configuration the sidebar just says "Cloud sync not
configured" and everything stays local.

### 1. Create a Supabase project

Free at [supabase.com](https://supabase.com) — about a minute.

### 2. Run the schema

**New project:** in Supabase → **SQL Editor → New query**, paste and run
`supabase/schema.sql`. This creates `nodes`, `dictionary`, `folders` and `cards`,
each with row-level security so a user can only ever read or write their own rows.

**Upgrading from an earlier version** (you already ran the old `schema.sql`, which
only created `nodes`): run `supabase/migration-002-sync-all.sql` instead. It adds
the three new tables and the two new `nodes` columns without touching your
existing notes, and is safe to run more than once.

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
  `updatedAt`, run independently over each of the four tables. It fires right
  after sign-in, every 20 seconds while signed in, whenever the tab regains
  focus, and on demand.
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
    schema.ts              # OutlinerNode, Flashcard, DictionaryEntry, PageFolder
    database.ts            # Dexie definition + v1→v8 migrations
    repository.ts          # all rem CRUD: create, indent, outdent, move, merge, links
    cardRepository.ts      # deriving and scheduling flashcards from rem content
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
  sync/
    syncEngine.ts          # table-agnostic last-write-wins merge
    supabaseClient.ts
supabase/
  schema.sql                     # fresh install
  migration-002-sync-all.sql     # upgrade from the notes-only schema
```

## What's not built

Image embedding is the one thing from the original roadmap still unimplemented.
