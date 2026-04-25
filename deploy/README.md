# Mote — Deployment

Docker-based deployment. The server runs three containers: the Go app, nginx (serves frontend + proxies API), and Redis. Host nginx handles HTTPS.

## Prerequisites

On the server:
- Docker with Compose plugin (`docker compose`)
- nginx + certbot (for HTTPS)
- git
- sqlite3 (for backups)

## First-time Setup

**1. Clone the repo on the server**
```bash
git clone https://github.com/cymoo/mote.git /opt/mote
cd /opt/mote
```

**2. Create `.env` from the example**
```bash
cp .env.example .env
# Edit .env and set MOTE_PASSWORD to a strong random string
nano .env
```

**3. Start services**
```bash
docker compose build
docker compose up -d
```

**4. Configure host nginx**

Copy `deploy/nginx-host.conf` to `/etc/nginx/sites-available/mote`, replace `example.com` with your domain, then:
```bash
certbot --nginx -d your-domain.com
ln -s /etc/nginx/sites-available/mote /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

**5. Configure local deploy tool**
```bash
cd deploy
cp .deploy.example .deploy
# Edit .deploy: set SERVER (e.g. user@1.2.3.4) and REMOTE_DIR
```

## Daily Workflow

From your local machine, inside `deploy/`:

```bash
make deploy    # backup → git pull → rebuild → restart (one command)
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
docker compose stop app
cp backups/backup-YYYYMMDD-HHMMSS/app.db data/app.db
docker compose start app
```

**Restore uploads:**
```bash
tar -xzf backups/backup-YYYYMMDD-HHMMSS/uploads.tar.gz -C .
```

## Directory Layout on Server

```
/opt/mote/
├── data/app.db       ← SQLite database (persistent)
├── uploads/          ← user-uploaded files (persistent)
├── backups/          ← backup sets (managed by backup.sh)
├── .env              ← secrets (not in git)
├── compose.yml
├── Dockerfile
├── Dockerfile.web
└── deploy/
    ├── nginx.conf        ← web container nginx config
    ├── nginx-host.conf   ← host nginx template
    └── backup.sh
```
