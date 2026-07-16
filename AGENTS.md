# Repository guidelines for AI assistants

A short, durable description of how this repository is laid out and the
conventions any agent (or human) should follow when changing code here.

## Project overview

Mote is a personal notebook + mini cloud drive web app. This branch
(`feat/api-rs`) is the **Rust edition**: a single React/Vite frontend speaks an
HTTP API to the Rust backend in `api-rs` (Axum + SQLite + Redis).

```
.
├── frontend/        React 18 + Vite + TypeScript + Tailwind. Single SPA.
├── api-rs/          Rust backend (Axum, SQLite, Redis).
├── deploy/          nginx + Docker Compose for production.
└── samples/         Sample database / screenshots.
```

The same HTTP API is implemented in other languages on their own long-lived
branches — `main` (Go, canonical) and `feat/api-kt` / `feat/api-py`. Day-to-day
development here almost always means **frontend + api-rs**.

## Frontend (`frontend/`)

* React 18, Vite 6, TypeScript strict, Tailwind v4, react-router v7,
  floating-ui, react-hot-toast, jest + playwright for tests.
* Path alias: `@/` → `frontend/src/`.
* i18n is a tiny in-house helper — `t('key', lang)` and `<T name="key" />` —
  with translations in `src/lang/{en,zh}.json`. **Always add both languages**
  when adding a key. Don't introduce a key you won't use.
* Reusable primitives live in `src/components/` (Button, Modal, Confirm,
  Dialog, Popover, Sortable, Translation…). Prefer them over native
  `confirm()` / `alert()` / raw `<dialog>`.
* Feature views live in `src/views/<feature>/`. The `files/` (drive) feature
  is a good template:
  - `layout.tsx`            persistent shell + nested `<Outlet/>`
  - `<route>-page.tsx`      one file per nested route
  - `parts.tsx` / `views.tsx`  shared presentational pieces
  - `hooks.ts`, `api.ts`, `dialogs.tsx`, `upload-manager.ts`, etc.
* State: prefer local `useState` + `useCallback`/`useMemo`. Reach for context
  only for cross-component coordination (auth, theme, modal stack). No Redux.
* URL is part of state. Folder navigation, filters and pagination must round-
  trip through the URL (`useSearchParams`) so browser back/forward works.
* Memoise hot leaf components (`memo`) and pass stable callbacks. Avoid prop-
  drilling enormous handler bags through wrappers.
* Toasts: `react-hot-toast`. Errors → `toast.error(err.message)`; success
  notifications should be brief.
* Keyboard shortcuts go through `useShortcuts` (see `views/files/`). Don't
  attach raw `keydown` listeners in feature code.

### Frontend commands

```bash
cd frontend
npm install
npm run dev          # vite dev server on :3000, proxies /api → :8000
npm run build        # tsc + vite build (must be clean before commits)
npm run lint         # eslint, --max-warnings 0
npm run test         # jest
npm run playwright   # e2e
```

`tsc --noEmit` and `npm run build` must both pass before any commit that
changes TypeScript.

## Backend (`api-rs/`)

The Rust backend (Axum + SQLite + Redis) lives in `api-rs/`. See
[api-rs/README.md](./api-rs/README.md) for the full build / test / run guide
(cargo, the `Makefile`, sqlx migrations, Redis).

Conventions that still apply:
* SQLite is single-writer. Wrap multi-statement writes in a transaction; never
  run independent statements expecting atomicity. Long reads can starve writes.
* New SQL goes through a numbered, embedded migration (a timestamped file under
  `migrations/`, compiled into the binary via `sqlx::migrate!`). Don't edit
  existing migrations once committed.
* Tests live next to the code (inline `#[cfg(test)]` modules and `src/tests/`);
  use the in-repo SQLite test helpers rather than mocking the DB.

## Coding conventions

* Make precise, surgical changes that fully address the task. Don't drive-by
  refactor unrelated code.
* Comment only code that needs clarification. No banner comments, no
  ASCII-art separators, no commented-out blocks (delete them).
* Match existing style. Frontend files use ESLint + Prettier defaults baked
  into the repo; Go uses `go fmt`.
* Keep diffs reviewable. If a change crosses 400+ lines, split it.
* Add or update tests for any non-trivial behaviour change. Never remove a
  test to make CI pass.

## Running the full stack locally

```bash
# terminal 1
cd api-rs && MOTE_PASSWORD=xxx cargo run   # or: make live (cargo-watch hot-reload)
# terminal 2
cd frontend && npm run dev
# open http://localhost:3000
```

The frontend proxies `/api/*` to `:8000`, so cookies and CORS work
identically to production.

## Conventions for AI agents specifically

* **Plan before coding** for non-trivial tasks; ask clarifying questions
  rather than guessing scope.
* **Verify before declaring done**: typecheck, build, and run the relevant
  test command. `npm run build` and `go build ./...` are cheap.
* **Commit messages**: imperative mood, short subject, body explaining the
  "why". Always include the `Co-authored-by` trailer for the Copilot agent
  when applicable. Use Conventional Commit prefixes (`feat`, `fix`,
  `refactor`, `chore`, `docs`, `test`).
* **Don't commit**: `dump.rdb`, `samples/app-dev.db`, generated bundles,
  `node_modules/`, `tmp/`, `.air.toml`, `*.sqlite-wal`/`-shm`. They're
  gitignored — keep them that way.
* **Don't touch** the api-rs migration history beyond appending. Don't reset
  schema versions.
* **Don't introduce** new dependencies casually. Prefer the in-house
  primitives (`@/components/*`, `pkg/*`) and standard library.
