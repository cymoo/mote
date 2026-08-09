---
name: mote
description: Operate the user's mote memo server — create, read, update, delete, search memos and manage tags. Use whenever the user wants to jot down / save / record a note, idea, or memo (记笔记/记一条/存个想法/写个备忘), find or search their notes (找笔记/搜笔记/查备忘), organize tags, or asks anything about their mote notes or memo statistics.
---

# mote — memo & tag operations

All operations go through one pure-stdlib Python CLI. Run it with `python3`:

```bash
python3 "$SKILL_DIR/scripts/mote.py" <command> [options]
```

`$SKILL_DIR` is this skill's directory. First use in a session: run `check` to verify connectivity.

Content is **always Markdown** on your side; the CLI converts to/from mote's internal
HTML. Never hand-write HTML content (use `get --html` only to inspect raw storage).

## Configuration

The CLI reads env `MOTE_BASE_URL` / `MOTE_TOKEN`, falling back to `~/.config/mote/config.json`:

```json
{"base_url": "https://your-mote-host", "token": "<MOTE_PASSWORD>"}
```

If `check` reports missing configuration, show the user the snippet above and ask them
to create the file themselves (`chmod 600`) — the token is their mote password; do not
ask them to paste it into the chat.

## Core commands

```bash
mote.py create --content "Learned a neat trick #tech/go"   # tags are written IN the content
mote.py list --tag tech --limit 20        # #tech and descendants like #tech/go
mote.py list --start 2026-08-01 --end 2026-08-07
mote.py get 42                            # full memo as Markdown
mote.py append 42 --content "follow-up thought"
mote.py update 42 --file new.md           # replaces the WHOLE content
mote.py update 42 --color red             # metadata only, content untouched
mote.py search "关键词 keyword"            # OR by default; --and requires all terms
mote.py delete 42                         # soft delete (trash, restorable)
mote.py restore 42
mote.py tags                              # tag tree with counts
mote.py tag rename tech technology        # cascades to tech/*, merges if target exists
mote.py stats                             # counts, top tags, colors
```

Multi-line content: prefer `--file`, or pipe stdin (`create`/`append` only;
`update` requires an explicit `--content`, `--file`, or `--stdin` since it
replaces the whole body). Add `--json` to any command for structured output.

## How tags work (important)

- A tag exists **only as `#name` text inside memo content** — `#tech/go` in the Markdown
  becomes a tag automatically on save. There is no separate tag field.
- Tags are hierarchical paths: `#a/b/c`. Filtering/renaming/deleting by `a` includes all
  descendants `a/*`.
- To tag an existing memo, `append` or `update` its content to include `#name`.
  To untag one memo, `update` its content without the `#name`. For bulk removal use
  `tag untag <name>` (keeps the memos, strips the tag text).
- Inline `#word` is a tag; a line starting with `# word` (hash + space) is a heading.
  A `#` glued to a word character is not a tag (`C#`, `page#anchor`), and `#fragment`
  inside a bare URL is left alone. Write `\#word` for a literal hash.
  Tag names allow letters, digits, CJK, `_`, `-`, `/`.
- Tag counts from `tags` include trashed memos.

## Destructive & public actions — confirm with the user first

Before running ANY of these, tell the user exactly what will be affected and get their
explicit confirmation in chat; then re-run with `--yes` (without `--yes` the CLI
dry-runs and prints the impact):

| command | effect |
|---|---|
| `delete <id> --hard --yes` | permanent, unrecoverable delete |
| `trash clear --yes` | permanently purges ALL trashed memos |
| `tag delete-memos <name> --yes` | soft-deletes EVERY memo under the tag and its descendants |
| `tag untag <name> --yes` | edits every memo carrying the tag (removes the tag text) |
| `update <id> --shared` / `create --shared` | **publishes the memo publicly** at `/shared/<id>` (no auth) |

Plain `delete <id>` (soft, restorable) needs no `--yes`; still avoid it unless asked.
Trash auto-purges after 30 days.

## Behavior notes

- `list` is cursor-paginated 10/page server-side; `--limit N` auto-pages, `--all` caps at 1000.
- `search` is Redis-backed and indexed asynchronously — a just-created memo may not be
  findable for a moment; fall back to `list` if a fresh memo is missing. Chinese is tokenized.
- Search returns one ranked batch (no pagination); scores shown per hit.
- Roundtrip is Markdown-faithful except: empty paragraphs are dropped, image
  width/height attributes are lost on content rewrite (`update`/`append`/`untag`).
- `get <id>` shows neither the tags array nor the parent memo (server limitation —
  only `list`/`search` attach them); tags are still visible as `#name` in the content.
- `--parent ID` on create makes a reply/quote of another memo; `list --parent ID` lists replies.
- `upload <file>` returns a URL to embed as `![](url)`.

Full API details (endpoints, field semantics, server quirks): see
[references/api.md](references/api.md).
