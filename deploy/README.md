# Mote — Deployment

Docker-based deployment. The server runs three containers: the Go app, Caddy (serves frontend + HTTPS + proxies API), and Redis. All persistent data lives in Docker named volumes — no host directories to create or manage.

## Prerequisites

On the server:
- Docker with Compose plugin v2.21+ (`docker compose`)
- git

## First-time Setup

All steps run from your **local machine**, inside `deploy/`.

**1. Configure the local deploy tool**
```bash
cp .deploy.example .deploy
# Edit .deploy: set SERVER (e.g. user@1.2.3.4) and REMOTE_DIR
```

**2. Create the app config**
```bash
cp .env.example .env
# Edit .env: set MOTE_PASSWORD (strong random string) and DOMAIN
```

**3. Run setup**
```bash
make setup
```

This clones the repo on the server, uploads `.env`, builds the frontend and Go binary, starts all containers. Caddy automatically obtains a TLS certificate on the first request — make sure your domain's DNS points to the server and ports 80/443 are open.

## Daily Workflow

From your local machine, inside `deploy/`:

```bash
make deploy    # backup -> git pull -> build frontend -> rebuild -> restart
make backup    # manual backup only
make logs      # tail app logs
make ps        # container status
make restart   # restart all containers
```

## Backup & Restore

Backups are stored in `/opt/mote/backups/` on the server. Each backup set contains:
- `app.db` — SQLite database (hot backup via VACUUM INTO)
- `uploads.tar.gz` — uploaded files

The last 5 backup sets are kept automatically.

**Restore database:**
```bash
# From /opt/mote/deploy on the server:
docker compose stop app
docker compose run --rm -v /opt/mote/backups/backup-YYYYMMDD-HHMMSS/app.db:/tmp/restore.db app \
  sh -c 'cp /tmp/restore.db /data/app.db'
docker compose start app
```

**Restore uploads:**
```bash
docker compose run --rm -v /opt/mote/backups/backup-YYYYMMDD-HHMMSS/uploads.tar.gz:/tmp/uploads.tar.gz app \
  sh -c 'tar -xzf /tmp/uploads.tar.gz -C /'
```

## Docker Volumes

All persistent data is stored in named Docker volumes (project name `mote`):

| Volume | Contents |
|--------|----------|
| `mote_app_data` | SQLite database |
| `mote_app_uploads` | User-uploaded files |
| `mote_web` | Built React SPA (rebuilt on each deploy) |
| `mote_caddy_data` | TLS certificates (keep to avoid rate limits) |
| `mote_redis_data` | Redis data |

## TLS / HTTPS

Caddy obtains and renews certificates from Let's Encrypt automatically. Certificates are stored in the `mote_caddy_data` volume — keep this volume intact to avoid hitting Let's Encrypt rate limits.

If you need to test without a real domain (e.g., on a staging server), add the following to `Caddyfile` before the site block to use Let's Encrypt's staging CA:
```
{
    acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
}
```
