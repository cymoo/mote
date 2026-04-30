# Repository guidelines for AI assistants

A short, durable description of how this repository is laid out and the
conventions any agent (or human) should follow when changing code here.

## Project overview

Mote is a personal notebook + mini cloud drive web app. The repo is
intentionally polyglot: a single React/Vite frontend speaks an identical HTTP
API to **four independent backend implementations** in different languages.
Each backend is a full rewrite of the same spec — they also serve as
side-by-side reference implementations.

```
.
├── frontend/        React 18 + Vite + TypeScript + Tailwind. Single SPA.
├── api-go/          Go (chi, sqlx, SQLite). Primary backend.
├── api-rs/          Rust port.
├── api-kt/          Kotlin port.
├── api-py/          Python port.
├── deploy/          nginx + Docker Compose for production.
└── samples/         Sample database / screenshots.
```

Day-to-day development almost always means **frontend + api-go**. Touch the
other backends only when the task explicitly says so or you're keeping them in
sync after a deliberate API change.

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
npm run dev          # vite dev server on :5173, proxies /api → :8000
npm run build        # tsc + vite build (must be clean before commits)
npm run lint         # eslint, --max-warnings 0
npm run test         # jest
npm run playwright   # e2e
```

`tsc --noEmit` and `npm run build` must both pass before any commit that
changes TypeScript.

## Go backend (`api-go/`)

* Go 1.22+, chi router, sqlx, SQLite (`mattn/go-sqlite3`), goose-style SQL
  migrations under `assets/migrations/`.
* Layout:
  - `cmd/server/`            entry point
  - `internal/app/`          wiring, routes, server lifecycle
  - `internal/handlers/`     HTTP handlers (one file per resource)
  - `internal/services/`     business logic; transactional boundaries
  - `internal/models/`       row structs; column tags only — no logic
  - `internal/tasks/`        background jobs (trash purge, share expiry)
  - `internal/config/`       env-driven config
  - `pkg/`                   small leaf packages (logger, http helpers)
* SQLite is single-writer. **Wrap multi-statement writes in a transaction**
  via the helper in `services/`; never run independent `Exec`s expecting
  atomicity. Be deliberate about locking — long reads can starve writes.
* Errors: return wrapped errors (`fmt.Errorf("doing X: %w", err)`), let
  handlers map to HTTP via the central error helper. Don't `log.Fatal` from
  request paths.
* New SQL goes through a numbered migration pair (`NNN_name.up.sql` /
  `.down.sql`). Don't edit existing migrations once committed.
* Tests sit next to the code (`*_test.go`); use the in-repo SQLite test
  helpers rather than mocking the DB.

### Go commands

```bash
cd api-go
make build           # go build → /tmp/bin/mote
make run             # build + run (dev DB at samples/app-dev.db by default)
make live            # air, hot-reload
make test            # go test -v -race ./...
make tidy            # go mod tidy + go fmt
go build ./...       # quick sanity check
```

`go build ./...` and `make test` must both pass before committing Go changes.

## Other backends

`api-rs/`, `api-kt/`, `api-py/` each have their own README and build system.
**Do not** modify them as a side effect of frontend or Go work. Touch them
only when:
1. The task explicitly says "sync the other backends", or
2. You changed the public HTTP/JSON contract and the user has agreed to fan
   the change out.

When fanning out, add a checklist and verify each backend's tests pass.

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
cd api-go && make live
# terminal 2
cd frontend && npm run dev
# open http://localhost:5173
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
* **Don't touch** the four migration histories beyond appending. Don't reset
  schema versions.
* **Don't introduce** new dependencies casually. Prefer the in-house
  primitives (`@/components/*`, `pkg/*`) and standard library.
