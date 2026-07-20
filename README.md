# Outliner App

A local-first, infinite-nesting outliner note app. Built from Phase 0–2 of the
architecture plan: project scaffolding, the "everything is a node" data layer,
and the core recursive outliner UI.

## Running locally

```bash
npm install
npm run dev
```

Open the printed localhost URL. Data is stored in your browser's IndexedDB
(via Dexie) — it persists across reloads but is local to that browser only,
no server or account needed yet.

## What's implemented (Phase 0–4, 6, 7, 8, 9, plus a dark-theme redesign — everything except flashcards)

- **Data layer** (`src/db/`): `OutlinerNode` schema, Dexie/IndexedDB setup,
  and a repository module (`repository.ts`) that's the single source of
  truth for all reads/writes — create, update, delete, indent, outdent,
  merge, reorder, plus link parsing/syncing, backlink queries, and
  breadcrumb path resolution.
- **Outliner UI** (`src/components/OutlinerNode.tsx`): recursive component,
  one per bullet. Each row is reactive via `useLiveQuery` (from
  `dexie-react-hooks`), so edits only re-render the row that changed.
- **Keyboard behavior**:
  - `Enter` — create a new sibling bullet below the current one
  - `Tab` — indent (nest under the previous sibling)
  - `Shift+Tab` — outdent (promote to the parent's level)
  - `Backspace` at the start of an empty bullet — merge into the previous sibling
- **Pages**: top-level nodes act as pages, listed in the left sidebar.
- **Collapse/expand**: click the ▾/▸ toggle next to any bullet with children.
- **Zoom navigation**: click the ⤢ icon next to any bullet (appears on
  hover) to zoom into it — it becomes the page root, showing just its
  subtree. A breadcrumb trail above the outliner shows the path back to
  the top-level page, and each crumb is clickable to jump back up.
- **Bidirectional links** (`[[Title]]`): type `[[` anywhere in a bullet to
  trigger an autocomplete dropdown (arrow keys + Enter/Tab to pick, Escape
  to dismiss). Links can now resolve to **any node**, not just top-level
  pages — clicking a link zooms straight into that bullet.
- **Backlinks panel**: every zoomed-in view shows a "Linked References"
  section at the bottom listing every bullet anywhere that links to it,
  with page context and a click-through that zooms directly to the
  linking bullet. Backed by a Dexie multiEntry index on `outboundLinks`,
  so lookups are indexed, not a full table scan.

- **Global search**: press `⌘K` / `Ctrl+K` (or click the search button in the
  sidebar) to open an omnibar. It fuzzy-searches every bullet's content
  across the whole app (via FlexSearch), shows which page each result
  lives on, and arrow keys + Enter jump straight to it via zoom
  navigation.

- **Portals (embeds)**: hover any bullet and click the ⧉ icon to embed a
  live, editable view of another node's subtree right inside the current
  one. It's not a copy — it's the exact same component bound to that
  node's id, so edits made inside the embed write straight back to the
  original. Click the embed's header to zoom to its real location, or the
  × to remove just the embed (the original node is untouched).

- **Rich text**: each bullet is now a real Tiptap editor. `**bold**`,
  `*italic*`, `` `code` ``, and code blocks (` ``` `) all work with the
  usual Markdown-style shortcuts, plus the standard `⌘B`/`⌘I` toggles.
- **Inline math**: type `$e=mc^2$` and the closing `$` instantly renders it
  as live KaTeX. Click a rendered formula to edit its LaTeX source (via a
  simple prompt dialog for now — a nicer inline editor is a natural
  follow-up).
- **`[[Links]]` are now a real editor node**, not just styled text: type
  `[[Title]]` and closing `]]` converts it into a clickable chip
  immediately. Blue = resolves to an existing node; amber = no match yet
  (clicking it creates a new page with that title on the fly, then zooms
  to it — no dead links).

### Known limitations from this pass

- **Link autocomplete while typing was dropped.** You still get full
  linking by typing `[[Title]]` in full, but there's no more live
  dropdown-as-you-type — reworking that against the new editor is a
  reasonable next increment.
- **Merging two bullets with Backspace now collapses to plain text.**
  Structural rich-text merging (preserving bold/links from both sides) is
  a nontrivial ProseMirror doc-merge operation that was descoped for now;
  merges still work, they just lose formatting on the row being merged in.
- The production bundle is now ~1MB (mostly KaTeX's font files + the
  Tiptap/ProseMirror engine) — fine for a personal local-first app, but
  worth revisiting with code-splitting if load time ever matters.

## Dark theme + toolbar

The whole app now runs on an original dark theme (not copied from any
specific product) with **Inter** as the default typeface (self-hosted via
`@fontsource/inter`, no external font CDN calls) and a floating bottom
toolbar that acts on whichever bullet you last had focused, via a shared
"active editor" context:

- **Heading** — dropdown for H1/H2/H3/Normal text
- **Todo** — toggles a checkbox task list on the current bullet
- **Table** — inserts a 3×3 table at the cursor
- **More** — extra formatting: bold, italic, strikethrough, inline code,
  code block
- **Undo**

The zoomed-in root node also now renders as a large page title (bigger
font, no bullet/buttons clutter) rather than looking like just another
row — while still being the same fully-functional, linkable, embeddable
node underneath.

Flashcards and image embedding were intentionally skipped from this pass.

## What's not built yet

Per the original roadmap, the only thing left unbuilt is:

- Flashcards + spaced repetition (SM-2) (Phase 5) — skipped for now
- Image embedding — skipped for now

The data model already anticipates flashcards (see `src/db/schema.ts`
comments) so it can be layered on without a rewrite.

## Cloud sync (Supabase) — setup

Cloud sync is fully optional. With no configuration, the app just runs
local-only (the sidebar shows "Cloud sync not configured"). To turn it on:

### 1. Create a Supabase project

Free at [supabase.com](https://supabase.com) — takes about a minute.

### 2. Run the schema

In your Supabase dashboard → **SQL Editor → New query**, paste and run
the contents of `supabase/schema.sql` from this project. This creates the
`nodes` table with row-level security, so each user can only ever read or
write their own rows.

### 3. Turn off email confirmation (optional, for quick testing)

By default Supabase requires confirming your email before you can sign
in. For personal use this is an unnecessary step — under
**Authentication → Providers → Email**, you can toggle "Confirm email"
off. (Leave it on if you want the extra safety.)

### 4. Get your API keys

**Project Settings → API** — you need the **Project URL** and the
**anon/public key** (not the service-role key — that one must never be
exposed in frontend code).

### 5. Local development

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

`.env` is gitignored — it will never get committed or pushed.

### 6. GitHub Pages deployment

The build step needs these same two values available as **GitHub Actions
secrets** (not committed to the repo, since env vars for a static build
get baked into the JS bundle at build time — that's expected/fine for an
anon/public key, which is designed to be safe to expose client-side since
row-level security is what actually protects your data, not secrecy of
this key).

In your repo: **Settings → Secrets and variables → Actions → New
repository secret**, add both:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

The deploy workflow (`.github/workflows/deploy.yml`) already reads these
in automatically — push to `main` and the next deploy will have sync
enabled.

### How it works

- **Auth**: email + password via Supabase Auth, sign in/up right in the
  sidebar.
- **Sync engine** (`src/sync/syncEngine.ts`): a two-way, last-write-wins
  merge by `updatedAt` — on sync, each node is compared between your
  local copy and the server's, and whichever was edited more recently
  wins and overwrites the other side. This runs automatically right after
  sign-in, every 20 seconds while signed in, whenever the tab regains
  focus, and on-demand via the "Sync now" button.
- **Deletes**: nodes are soft-deleted (a `deletedAt` timestamp field
  rather than actually removing the row), so a delete is just another
  field change that propagates through the same last-write-wins merge —
  no special-case logic needed, and deleted notes won't get
  "resurrected" by an out-of-date device.

### Known limitations

- **Conflict resolution is whole-node last-write-wins, not field-level.**
  If you edit the exact same bullet on two devices while both are
  offline, whichever synced most recently wins entirely — there's no
  merge of the two edits. Fine for the common case (one device at a
  time), but worth knowing.
- **No realtime push.** Sync is polling-based (every 20s + on focus +
  on-demand), not an instant live connection via Supabase's realtime
  channels. Good enough for "edit on my laptop, pick up on my phone a
  bit later," not true simultaneous multi-device live editing.
- **Tombstones accumulate forever** — deleted nodes stay in the database
  as soft-deleted rows rather than ever being purged. Not a problem at
  personal-notes scale, but a periodic cleanup job would be a sensible
  addition if this ever needs to scale up.

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. In `vite.config.ts`, the `base` path is set to `/clemnotes/` when
   `GITHUB_PAGES=true` — update that string if you ever rename the repo.
3. In your repo settings, enable **Pages → Source: GitHub Actions**.
4. Push to `main` — the included workflow (`.github/workflows/deploy.yml`)
   builds and deploys automatically.

## Project structure

```
src/
  db/
    schema.ts       # OutlinerNode type + factory
    database.ts      # Dexie database definition
    repository.ts     # all CRUD / indent / outdent / merge logic
  components/
    OutlinerNode.tsx  # recursive bullet row component
  App.tsx             # sidebar + active page view
  App.css
```
