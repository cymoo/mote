# mote API reference (for the `mote` skill)

Everything the CLI wraps. Base: `<base_url>/api`, auth: `Authorization: Bearer <MOTE_PASSWORD>`
(the token IS the password — no sessions, no expiry). Errors: `{"code","error","message"}`;
mutations return 204 with an empty body. All timestamps are Unix **milliseconds**.
Source of truth: `api-go/internal/app/routes.go`, `handlers/post_api.go`, `handlers/tag_api.go`.

## Memo endpoints

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/get-posts` | query filters below | `{posts, cursor, size}` |
| GET | `/api/get-post?id=N` | | Post (404 if missing **or trashed**) |
| GET | `/api/search` | `query`, `limit`, `partial` | `{posts, cursor:-1, size}` |
| POST | `/api/create-post` | `{content, files, color, shared, parent_id}` | `{id, created_at, updated_at}` |
| POST | `/api/update-post` | `{id, content?, shared?, files?, color?, parent_id?}` | 204 |
| POST | `/api/delete-post` | `{id, hard}` | 204 |
| POST | `/api/restore-post` | `{id}` | 204 |
| POST | `/api/clear-posts` | `{}` | 204 (empties trash) |
| POST | `/api/upload` | multipart field `file` | `{url, thumb_url?, size?, width?, height?}` |
| GET | `/api/get-overall-counts` | | `{post_count, tag_count, day_count}` |
| GET | `/api/get-daily-post-counts` | `start_date`, `end_date` (YYYY-MM-DD), `offset` (min) | `[int]` |
| GET | `/api/get-stats-summary` | same dates (both or neither) | totals, color_counts, top_tags |
| GET | `/api/auth` | | 200 if token valid |

`get-posts` filters (query string): `cursor` (ms value of last item's order column),
`deleted`, `parent_id`, `color` (red/green/blue), `tag`, `shared`, `has_files`,
`untagged`, `order_by` (`created_at`/`updated_at`), `ascending`, `start_date`/`end_date`
(**ms epoch**, unlike the stats endpoints' YYYY-MM-DD).

## Tag endpoints

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/get-tags` | | `[{name, sticky, post_count}]` |
| POST | `/api/rename-tag` | `{name, new_name}` | rename/merge, cascades to descendants |
| POST | `/api/delete-tag` | `{name}` | **soft-deletes all memos** under tag + descendants |
| POST | `/api/stick-tag` | `{name, sticky}` | pin/unpin (upsert — can create an empty tag) |

## Server quirks the CLI compensates for

1. **Tags derive from content.** Server regex `<span class="hash-tag">#(.+?)</span>`
   rebuilds all associations on every create/update-with-content. The `tags` array in
   responses is read-only.
2. **Content is Slate-style HTML**, closed element set: `p, h1-h5, ul/ol/li (nested),
   blockquote, pre>code, a[target=_blank][rel], figure>img(+figcaption),
   table/thead/tbody/tr/th/td[style=text-align], div.check-list>input+label,
   span.hash-tag, strong/em/del/u/code, br`. Only `<` and `>` are entity-escaped.
3. **Hard delete requires prior soft delete** — `DELETE ... WHERE deleted_at IS NOT NULL`
   silently no-ops (still 204) on a live memo. Same for `restore-post` on a live memo.
   The CLI chains soft→hard for `delete --hard` and verifies after `restore`.
4. **`delete-tag` deletes memos, not the tag** — exposed as `tag delete-memos`.
   No API removes a tag row or untags in bulk; `tag untag` is a client-side loop
   (fetch → strip span → update each).
5. **Page size hardcoded to 10**; cursor = last item's `order_by` value; response
   `cursor:-1` only on an empty page. The CLI auto-pages.
6. **Search**: Redis inverted index (TF-IDF, `gse` tokenizer, Chinese-aware).
   `partial=true` = OR, omitted = AND. Indexing is async fire-and-forget — fresh
   memos may lag; if Redis is down, search silently misses. Results inject
   `<mark>` into content — stripped by the CLI, must never be written back.
7. **`shared:true` publishes** at `/shared/{id}` outside auth.
8. `parent_id` is never in responses (`json:"-"`); a nested `parent` object is.
   **But `get-post` (single memo) attaches neither `tags` (hardcoded `[]`,
   `services/post.go:87`) nor `parent`** — only list/search/FindByIDs do. Read tags
   from the content text, or find the memo via `list`.
9. `get-tags` `post_count` rolls up descendants and **includes trashed memos**.
10. `rename-tag` rewrites content via SQL `REPLACE(content,'>#old<','>#new<')` and does
    not reindex search. Renaming into one's own subtree is rejected.
11. Update tri-state: `files`/`color`/`parent_id` — key omitted = unchanged,
    `null` = clear, value = set. `content`/`shared` — omitted = unchanged.
12. Nightly job (02:00) purges trash older than 30 days; monthly search reindex.
13. Login endpoint `/api/login` is only a password probe (204, no cookie);
    clients just send the bearer header everywhere.
