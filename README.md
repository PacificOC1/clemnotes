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

## What's implemented (Phase 0–4, 6, 7, 8 — everything except flashcards and sync)

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

## What's not built yet (next phases)

Per the original roadmap, these are separate phases to tackle next:

- Flashcards + spaced repetition (SM-2) (Phase 5) — skipped for now
- Cloud sync (Phase 9)

The data model already anticipates most of these (see `src/db/schema.ts`
comments) so they can be layered on without a rewrite.

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
