# Mote

[中文介绍](./README-zh.md)

![screenshot](./samples/screenshot.png)

Mote is a simple personal notebook and blog web app.

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
* **Files** — built-in mini cloud drive: multi-level folders, drag-and-drop chunked & resumable uploads (up to 4 GB), in-browser preview (image / video / audio / PDF / text), zip download for folders, password-protected share links with optional expiry, and a separate trash with 30-day retention
* **Dark / light theme**
* **Mobile-friendly** responsive layout
* **Bilingual UI** — switch between Chinese and English in settings

## Deployment

For production, see [deploy/](./deploy) — nginx + Docker Compose with HTTPS via certbot, automated backup included.

Four independent backend implementations — [api-go](./api-go), [api-rs](./api-rs), [api-kt](./api-kt), [api-py](./api-py) — expose an identical API. Each was a rewrite in a new language, so they also serve as side-by-side reference implementations. Each directory contains its own development guide.

## License

MIT
