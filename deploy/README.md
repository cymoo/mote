# Mote — Deployment

Everything runs from **your machine**. You never SSH in to deploy.

The server holds no source code, no Git checkout, no Docker, and no Go or Node
toolchain — only a static binary, the built SPA, SQLite, Redis and nginx.

```
your machine                             server
────────────                             ──────
yarn build        ──┐
go build (linux)  ──┴─→ rsync ─────────→ /opt/mote/releases/<id>/{mote,web/}
                                         current -> releases/<id>   (atomic flip)
                                         systemctl --user restart mote
                                         wait for /health, else roll back
```

`make deploy` needs **no sudo** and touches nothing outside `/opt/mote` and the
deploy user's own systemd units.

## Prerequisites

On your machine: `go`, `yarn`, `rsync`, `ssh`, `git`.

The local scripts stay within what macOS ships — bash 3.2 and rsync 2.6.9 — so
avoid `mapfile`, bare `"${arr[@]}"` on a possibly-empty array, `--chmod=F644`
and `--info=progress2` when editing them.

On the server: Ubuntu/Debian with `nginx`, `certbot`, and key-based SSH login
for a non-root user. Everything else is installed by `make bootstrap`.

## First-time setup

```bash
cd deploy
cp deploy.env.example deploy.env    # SSH_HOST, SSH_USER, DOMAIN, REMOTE_DIR
make bootstrap                      # asks once for the remote sudo password
make deploy
```

`make bootstrap` is the only step that needs sudo. It installs `sqlite3` and
`redis-server`, disables the distro's system-wide Redis (Mote runs its own user
instance), enables lingering so user services start at boot, creates
`/opt/mote/config/mote.env`, installs the systemd units, and configures nginx —
obtaining a TLS certificate via certbot if there isn't one yet.

Before running it, make sure the domain's A record points at the server and
ports 80/443 are open.

Set `MOTE_PASSWORD` in `/opt/mote/config/mote.env` on the server. It is
deliberately never stored in this repo and never transferred from your machine.

## Day to day

```bash
make deploy        # build, ship, activate, health-check
make status        # service state, current release, disk, release list
make logs          # follow the app log
make rollback      # back to the previous release (RELEASE=<id> to pick one)
make restart       # restart without deploying
make backup        # hot-backup the database
make pull-uploads  # mirror the server's uploads/ to this machine
make nginx         # push nginx.conf and reload (asks for remote sudo)
make shell         # ssh in, in the app directory
```

`make deploy` refuses to run with an uncommitted working tree so a release
always maps to a commit. Use `make deploy-dirty` when you deliberately want to
ship work in progress; those releases are tagged `<sha>-dirty`.

## Layout on the server

| Path | Contents |
|------|----------|
| `/opt/mote/releases/<ts>-<sha>/` | One release: the `mote` binary and `web/` (the built SPA) |
| `/opt/mote/current` | Symlink to the active release. nginx and systemd both read through it |
| `/opt/mote/data/app.db` | SQLite database |
| `/opt/mote/uploads/` | User uploads. Drive blobs under `uploads/drive/` are served by nginx via `X-Accel-Redirect` after the app authorises the request |
| `/opt/mote/redis/dump.rdb` | Redis persistence |
| `/opt/mote/backups/` | Database backups (last 10) |
| `/opt/mote/config/mote.env` | `MOTE_PASSWORD` and optional tunables. Server-owned, never in Git |
| `/opt/mote/config/{redis,nginx}.conf` | Rendered from this directory on every deploy |
| `/opt/mote/bin/` | The scripts in `remote/`, uploaded on every deploy |
| `~/.config/systemd/user/mote{,-redis}.service` | The two services |

Releases are uploaded with `rsync --link-dest --checksum --no-times`, so files
that are byte-identical to the previous release are hardlinked rather than
re-uploaded and re-stored. `--checksum --no-times` is load-bearing: each build
writes fresh mtimes, and `--link-dest` only hardlinks on an exact match
*including* times, so plain `-a` would silently link nothing.

## Rollback

`make rollback` repoints `current` at the previous release and restarts. It is
a symlink flip — a couple of seconds, no rebuild.

Deploys roll back on their own too: if the new release does not report healthy
within 45s, `current` goes back to the previous release, the service restarts,
and the deploy exits non-zero.

## Backup & restore

`make backup` runs `VACUUM INTO` against the live database — a consistent hot
copy, safe while the app is serving. It runs automatically before every deploy.
The last 10 copies are kept in `/opt/mote/backups/`.

Uploads are **not** part of that backup: they are much larger than the server's
free disk, so copying them there would fill the disk they are meant to protect.
Use `make pull-uploads` to mirror them onto your own machine instead.

Restore the database:

```bash
make shell
systemctl --user stop mote
cp backups/app-YYYYMMDD-HHMMSS.db data/app.db
rm -f data/app.db-wal data/app.db-shm
systemctl --user start mote
```

## Redis

Redis holds only derived state: the full-text inverted index and share-link
rate-limit counters. If it is ever lost or started empty, search returns nothing
until the index is rebuilt — run the `rebuild-fulltext-index` task from
`https://<domain>/tasks/`, which reindexes every post from SQLite.

That is also why `maxmemory-policy` is `noeviction`: silently evicting index
keys would corrupt search results without surfacing an error.

## TLS

certbot's systemd timer renews the certificate and reloads nginx via the deploy
hook installed during bootstrap. Verify with `certbot renew --dry-run`.

## nginx

nginx config is not applied by `make deploy`, because that would require sudo.
Deploys compare the rendered config against what the server is serving and warn
if they differ; `make nginx` then installs it and reloads.
