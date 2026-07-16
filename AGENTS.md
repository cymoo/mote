# Repository guidelines for AI assistants

A short, durable description of how this repository is laid out and the
conventions any agent (or human) should follow when changing code here.

## Project overview

Mote is a personal notebook + mini cloud drive web app. This branch
(`feat/api-kt`) is the **Kotlin edition**: a single React/Vite frontend speaks
an HTTP API to the Kotlin backend in `api-kt` (Spring Boot + JOOQ + SQLite,
Flyway migrations).

```
.
├── frontend/        React 18 + Vite + TypeScript + Tailwind. Single SPA.
├── api-kt/          Kotlin backend (Spring Boot, JOOQ, SQLite, Flyway).
├── deploy/          nginx + Docker Compose for production.
└── samples/         Sample database / screenshots.
```

The same HTTP API is implemented in other languages on their own long-lived
branches — `main` (Go, canonical) plus `feat/api-rs` and `feat/api-py`. On this
branch, day-to-day development means **frontend + api-kt**.

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

## Backend (`api-kt/`)

Kotlin + Spring Boot + JOOQ over SQLite, with Flyway migrations (and Redis).
See [api-kt/README.md](./api-kt/README.md) — and the `Makefile` next to it
(`make run` / `build` / `test` / `jooq` / `migrate`) — for the authoritative
build, test, and run instructions. Two invariants to respect:

* **Flyway migrations are append-only.** Add a new numbered migration; never
  edit or renumber one that's already committed, and don't reset schema
  versions.
* **JOOQ codegen reads the schema of `samples/app-dev.db`** (see the
  `jooq-codegen` config in `pom.xml`). The generated types are derived from
  that database, so keep its schema in sync with the migrations before
  regenerating.

## Coding conventions

* Make precise, surgical changes that fully address the task. Don't drive-by
  refactor unrelated code.
* Comment only code that needs clarification. No banner comments, no
  ASCII-art separators, no commented-out blocks (delete them).
* Match existing style. Frontend files use ESLint + Prettier defaults baked
  into the repo; keep Kotlin in `api-kt` consistent with the surrounding code.
* Keep diffs reviewable. If a change crosses 400+ lines, split it.
* Add or update tests for any non-trivial behaviour change. Never remove a
  test to make CI pass.

## Running the full stack locally

```bash
# terminal 1 — Kotlin backend (needs Redis up; see api-kt/README.md)
cd api-kt && ./mvnw jooq-codegen:generate && MOTE_PASSWORD=foobar ./mvnw spring-boot:run
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
  test command. `npm run build` (frontend) and the `api-kt` Maven build /
  tests (see [api-kt/README.md](./api-kt/README.md)) are the sanity checks.
* **Commit messages**: imperative mood, short subject, body explaining the
  "why". Always include the `Co-authored-by` trailer for the Copilot agent
  when applicable. Use Conventional Commit prefixes (`feat`, `fix`,
  `refactor`, `chore`, `docs`, `test`).
* **Don't commit**: `dump.rdb`, generated bundles, `node_modules/`, `tmp/`,
  `target/`, `*.sqlite-wal`/`-shm`. They're gitignored — keep them that way.
  `samples/app-dev.db`, by contrast, *is* tracked here on purpose (JOOQ codegen
  reads its schema), so don't gitignore or delete it.
* **Don't touch** this backend's Flyway migration history beyond appending.
  Don't reset schema versions.
* **Don't introduce** new dependencies casually. Prefer in-house primitives
  (`@/components/*` on the frontend, existing helpers in `api-kt`) and the
  standard library.
