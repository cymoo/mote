# Mote — Deployment

Host nginx + Docker deployment. nginx handles HTTPS, serves static files and uploads; the Go app and Redis run in Docker containers.

## Prerequisites

On the server:
- Docker with Compose plugin v2.21+
- nginx
- certbot
- git

## First-time Setup

SSH into the server and run everything from `deploy/`:

```bash
# Clone to any path you prefer; /opt/mote is the conventional choice.
# Non-root users typically lack write access to /opt, so either use sudo
# or choose a user-writable location such as ~/mote.
sudo git clone https://github.com/cymoo/mote.git /opt/mote
# — or —
git clone https://github.com/cymoo/mote.git ~/mote

cd /opt/mote/deploy       # adjust if you chose a different path
cp .env.example .env      # edit: MOTE_PASSWORD, DOMAIN
make setup
```

`make setup` will:
1. Build and start the Go app + Redis containers
2. Configure nginx with a temporary HTTP-only config
3. Obtain a TLS certificate via certbot (webroot mode)
4. Switch nginx to the full HTTPS config

Before running `make setup`, ensure:
- Your domain's DNS A record points to this server
- Ports 80 and 443 are open in your firewall
- nginx and certbot are installed (`apt install nginx certbot` or equivalent)

> **Note:** `make setup` automatically removes `/etc/nginx/sites-enabled/default` to avoid port 80 conflicts on Ubuntu/Debian.

## Daily Workflow

SSH into the server, `cd /opt/mote/deploy`, then:

```bash
make deploy    # backup -> git pull -> rebuild -> restart
make backup    # manual backup
make logs      # tail app logs
make ps        # container status
make restart   # restart all containers
```

## Backup & Restore

Backups are stored in `/opt/mote/backups/`. Each backup set contains:
- `app.db` — SQLite database (hot backup via VACUUM INTO)
- `uploads.tar.gz` — uploaded files

The last 5 backup sets are kept automatically.

**Restore database:**
```bash
# From /opt/mote/deploy on the server:
docker compose stop app
cp /opt/mote/backups/backup-YYYYMMDD-HHMMSS/app.db /opt/mote/data/app.db
docker compose start app
```

**Restore uploads:**
```bash
tar -xzf /opt/mote/backups/backup-YYYYMMDD-HHMMSS/uploads.tar.gz -C /opt/mote
```

## Data Layout

| Path | Contents |
|------|----------|
| `/opt/mote/data/app.db` | SQLite database (bind-mounted into container) |
| `/opt/mote/uploads/` | User-uploaded files; Drive blobs under `uploads/drive/` are served by nginx through an internal accelerated location after app auth checks |
| `/opt/mote/web/` | Built React SPA (served by nginx) |
| `/opt/mote/backups/` | Backup sets |

Redis data is stored in a Docker named volume (`mote_redis_data`).

## TLS / HTTPS

Certbot obtains and auto-renews the certificate. Renewal is triggered automatically by certbot's systemd timer (installed with certbot). On each renewal, the deploy hook `nginx -s reload` runs automatically. Certificates are stored in `/etc/letsencrypt/live/<DOMAIN>/`.

To verify renewal works: `certbot renew --dry-run`
