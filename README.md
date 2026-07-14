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

## What's implemented (Phase 0–2 MVP)

- **Data layer** (`src/db/`): `OutlinerNode` schema, Dexie/IndexedDB setup,
  and a repository module (`repository.ts`) that's the single source of
  truth for all reads/writes — create, update, delete, indent, outdent,
  merge, reorder.
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

## What's not built yet (next phases)

Per the original roadmap, these are separate phases to tackle next:

- Zoom-into-node page navigation (Phase 3)
- `[[bidirectional links]]` + backlinks panel (Phase 4)
- Flashcards + spaced repetition (SM-2) (Phase 5)
- Rich text / LaTeX / code blocks via Tiptap (Phase 6)
- Portals — embedding a live view of one node inside another (Phase 7)
- Global search (Phase 8)
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
