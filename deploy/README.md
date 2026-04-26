# Mote — Deployment

Docker-based deployment. The server runs three containers: the Go app, Caddy (serves frontend + HTTPS + proxies API), and Redis. No host-level nginx or certbot needed — Caddy handles TLS automatically.

All server-side commands below are run from `/opt/mote/deploy/`.

## Prerequisites

On the server:
- Docker with Compose plugin v2.21+ (`docker compose`)
- git
- sqlite3 (for backups)

## First-time Setup

**1. Clone the repo on the server**
```bash
git clone https://github.com/cymoo/mote.git /opt/mote
cd /opt/mote/deploy
```

**2. Create `.env` from the example**
```bash
cp .env.example .env
# Edit .env: set MOTE_PASSWORD (strong random string) and DOMAIN (your domain)
nano .env
```

**3. Create data directories**
```bash
mkdir -p ../data ../uploads ../web
```

**4. Build the frontend and start services**
```bash
# Build frontend assets and extract to ../web
docker build -t mote-frontend -f Dockerfile.frontend ..
docker run --rm -v /opt/mote/web:/dist mote-frontend sh -c 'rm -rf /dist/* && cp -r /app/dist/. /dist/'

# Build and start all containers
docker compose build
docker compose up -d
```

Caddy will automatically obtain a TLS certificate from Let's Encrypt on the first request. Make sure your domain's DNS points to the server and ports 80/443 are open before starting.

**5. Configure local deploy tool**
```bash
cp .deploy.example .deploy
# Edit .deploy: set SERVER (e.g. user@1.2.3.4) and REMOTE_DIR
```

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
cp ../backups/backup-YYYYMMDD-HHMMSS/app.db ../data/app.db
docker compose start app
```

**Restore uploads:**
```bash
tar -xzf ../backups/backup-YYYYMMDD-HHMMSS/uploads.tar.gz -C ..
```

## Directory Layout on Server

```
/opt/mote/
├── data/app.db       <- SQLite database (persistent)
├── uploads/          <- user-uploaded files (persistent)
├── web/              <- built React SPA (populated by deploy)
├── backups/          <- backup sets (managed by backup.sh)
└── deploy/
    ├── .env              <- secrets (not in git)
    ├── .deploy           <- local deploy config (not in git)
    ├── compose.yml
    ├── Caddyfile
    ├── Dockerfile.api
    ├── Dockerfile.frontend
    ├── Makefile
    ├── backup.sh
    └── README.md
```

## TLS / HTTPS

Caddy obtains and renews certificates from Let's Encrypt automatically. Certificates are stored in the `caddy_data` Docker volume — keep this volume intact to avoid hitting Let's Encrypt rate limits.

If you need to test without a real domain (e.g., on a staging server), add the following to `Caddyfile` before the site block to use Let's Encrypt's staging CA:
```
{
    acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
}
```
