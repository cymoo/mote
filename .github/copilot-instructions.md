# Copilot Instructions for Mote

## Project Overview

Mote is a personal notebook and blog web app. It has one React frontend and **four interchangeable backend implementations** (Go, Rust, Kotlin, Python) that expose the same API. You will typically work in one backend at a time.

## Architecture

```
frontend/       React + Vite + TypeScript + Tailwind CSS v4 + Slate editor
api-go/         Go + chi + net/http + SQLite + Redis
api-rs/         Rust + Axum + SQLite + Redis
api-kt/         Kotlin + Spring Boot + JOOQ + Flyway + SQLite + Redis
api-py/         Python + Flask + SQLAlchemy + Alembic + SQLite + Redis
deploy/         Production deployment scripts (nginx, systemd, HTTPS)
data/           Shared SQLite database files
```

All backends share the same SQLite schema (in `data/`) and the same API surface:
- `/api/*` — JSON API (requires auth)
- `/shared/*` — Blog pages (server-side rendered via Jinja2/Go templates)
- Static files embedded in the binary or served from a directory

**Full-text search** is implemented with a custom inverted index + TF-IDF backed by Redis (no Elasticsearch). Chinese tokenization uses Jieba (jieba-rs in Rust, gse in Go).

**Authentication** is password-only: `MOTE_PASSWORD` env var is required at startup. The token is compared directly (no JWT). Clients store the token in localStorage and send it as a `Bearer` header or cookie.

SQLite runs with `WAL` mode and `foreign_keys = ON` enabled in all backends.

Background tasks run on a schedule: delete old posts daily at 2 AM, rebuild the FTS index on the 1st of each month at 2 AM.

## Build, Run & Test Commands

All backends require a running Redis server (`redis-server`) before starting.

### Frontend (`frontend/`)

```bash
yarn install
npm run dev          # dev server at http://localhost:3000
npm run build        # production build → dist/
npm run lint         # ESLint
npm test             # Jest unit tests
npm run playwright   # Playwright e2e tests
```

Single Jest test: `npx jest --testPathPattern=<filename>`

### Go (`api-go/`)

```bash
MOTE_PASSWORD=xxx make run       # build & run
make live                         # live reload (uses air)
make test                         # go test -v -race ./...
make tidy                         # go mod tidy + go fmt
```

Single test: `go test -v -run TestFunctionName ./internal/services/`

### Rust (`api-rs/`)

```bash
MOTE_PASSWORD=xxx make run        # debug mode
make live                          # live reload (cargo-watch)
make test                          # RUST_TEST_THREADS=1 cargo test
make format                        # cargo fmt
make lint                          # cargo clippy -- -D warnings
make db-reset                      # drop, create, and migrate DB
```

Single test: `RUST_TEST_THREADS=1 cargo test test_function_name`

Tests **must** run single-threaded (`RUST_TEST_THREADS=1`) because they share the SQLite database.

### Kotlin (`api-kt/`)

```bash
make jooq                          # generate JOOQ code (required before first run)
MOTE_PASSWORD=xxx make run         # dev server (SPRING_PROFILES_ACTIVE=dev)
make test                          # SPRING_PROFILES_ACTIVE=test ./mvnw test
make migrate                       # Flyway migration
```

JOOQ code must be regenerated after schema changes.

### Python (`api-py/`)

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
MOTE_PASSWORD=xxx flask run        # dev server
pytest .                           # all tests
flask create_tables                # init DB
flask db upgrade                   # run Alembic migrations
```

## Key Conventions

### All backends
- `MOTE_PASSWORD` env var is mandatory; the app panics on startup if unset.
- Configuration is loaded from `.env` (base) → `.env.dev`/`.env.prod` → `.env.local` (highest priority) in Rust/Go. Kotlin uses Spring profiles via `SPRING_PROFILES_ACTIVE`.
- API error responses follow `{ "code": <int>, "error": "<string>", "message": "<string>" }`.

### Go backend
- Handlers use `github.com/cymoo/mint` (`m.H(handler)`) for typed request/response wrapping.
- Errors are returned as `m.HTTPError{Code, Err, Message}`; helpers in `internal/errors/` (`errors.NotFound()`, `errors.BadRequest()`, etc.).
- Background tasks use `github.com/cymoo/mita` (task manager).
- Layered structure: `internal/handlers/` → `internal/services/` → `internal/models/`.

### Rust backend
- All handlers return `ApiResult<T>` (`Result<T, ApiError>`).
- `AppState` is shared via `Arc`; cloning it is cheap.
- `ApiError` implements `From<sqlx::Error>`, `From<anyhow::Error>`, etc., so `?` works everywhere.

### Kotlin backend
- JOOQ is used for all DB queries (type-safe, no raw SQL in services).
- Spring profiles: `dev` (default), `prod`, `test`.

### Frontend
- The Slate-based rich text editor lives in `frontend/src/components/editor/` (~3,000 lines). It is complex; prefer extending existing patterns over restructuring it.
- State management: Zustand (`stores/`). Data fetching: SWR.
- API calls go through `frontend/src/api.ts` (`fetcher()`), which attaches the Bearer token automatically.
- React Router v7 is used for routing (`frontend/src/route.tsx`).
- Tailwind CSS v4 (no `tailwind.config.js`; config is in CSS/`@theme`).

## Git Commit Messages
After completing a task, commit the changes once the code is working and all relevant tests pass — unless the user explicitly asks not to commit.

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <short summary>

[optional body — explain *what* and *why*, not *how*]

[optional footer(s)]
```

**Types**: `feat`, `fix`, `refactor`, `perf`, `style`, `test`, `docs`, `chore`, `ci`, `build`

**Rules**:
- Subject line: imperative mood, no period, ≤ 72 chars
- Scope: the module/layer being changed (optional but encouraged)
- Body: wrap at 72 chars; use bullet points for multiple changes
- Breaking changes: add `BREAKING CHANGE:` footer or append `!` after type
