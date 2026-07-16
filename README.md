# Mote

[中文介绍](./README-zh.md)

![screenshot](./samples/screenshot.png)

Mote is a simple personal notebook and blog web app. **This branch is the Kotlin edition** — the backend in [api-kt](./api-kt) is built with Spring Boot + JOOQ + SQLite.

## Features

* **Rich-text editor** — Markdown shortcuts, auto-save drafts
* **Hashtags** — type `#tag` inline to create tags automatically; supports multi-level tags (`parent/child`); tags are pinnable, renameable, and deleteable
* **Image galleries** — attach multiple images to a memo, displayed in a grid
* **Blog sharing** — publish any memo as a public blog post with its own URL
* **Full-text search** — search across all memos; sort by relevance, newest, or oldest
* **Memo linking** — quote or reply to an existing memo; detach the link anytime
* **Color marking** — mark memos red, green, or blue for quick visual grouping
* **Activity heat map** — GitHub-style grid showing daily writing frequency
* **Stats panel** — total memo count, tag count, and active day count
* **Recycle bin** — soft-delete with 30-day retention; restore or permanently delete
* **Files** — built-in mini cloud drive: multi-level folders, drag-and-drop chunked & resumable uploads (up to 4 GB) including whole-folder uploads, server-side dedup (identical files share one blob), copy / duplicate, drag-to-move, right-click context menus, starred favorites, storage-usage display, in-browser preview (image / video with resume & speed control / audio / PDF / text with syntax highlighting), zip download for folders and multi-selections, password-protected share links (files *and* folders, with a browsable visitor page) with optional expiry, and a separate trash with 30-day retention
* **Dark / light theme**
* **Mobile-friendly** responsive layout
* **Bilingual UI** — switch between Chinese and English in settings

## Editions

Mote is intentionally polyglot: one shared React frontend and the same HTTP API, implemented in several languages. Each backend lives on its own long-lived branch:

| Edition | Branch | Backend |
| --- | --- | --- |
| Go (canonical) | `main` | `api-go` |
| Rust | `feat/api-rs` | `api-rs` |
| Kotlin | `feat/api-kt` | `api-kt` |
| Python | `feat/api-py` | `api-py` |

You're on **`feat/api-kt`**. See [api-kt/README.md](./api-kt/README.md) to build and run the backend; the frontend in [frontend/](./frontend) is shared across every edition.

## Deployment

For production, see [deploy/](./deploy) — nginx + Docker Compose with HTTPS via certbot and automated backups. Note: the deploy scripts currently build the Go backend (`deploy/Dockerfile.api`, `deploy/compose.yml`); adapt them to build `api-kt` for this edition.

## License

MIT
