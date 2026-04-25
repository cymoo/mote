# Deployment Documentation

This document describes how to deploy and manage Mote.

**Normal deployments are fully automatic**: push to `main` → GitHub Actions builds the Go binary and frontend → uploads artifacts to the server → restarts the service.

This guide covers first-time server setup and emergency manual operations.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [GitHub Secrets Setup](#github-secrets-setup)
- [First-time Server Setup](#first-time-server-setup)
- [Daily Maintenance](#daily-maintenance)
- [Emergency Manual Deployment](#emergency-manual-deployment)
- [Troubleshooting](#troubleshooting)
- [Script Reference](#script-reference)

## Architecture Overview

```
push to main
    │
    ▼
GitHub Actions (.github/workflows/deploy.yml)
    ├── Build Go binary  (api-go/)
    ├── Build frontend   (frontend/)
    └── SCP artifacts → server → deploy-artifacts.sh

Server (initialized once manually)
    ├── /opt/mote/api/current/mote   ← Go binary (replaced on each deploy)
    ├── /opt/mote/web/build/         ← Frontend assets (replaced on each deploy)
    ├── /opt/mote/data/app.db        ← SQLite database (persistent)
    ├── /opt/mote/uploads/           ← User uploads (persistent)
    └── /opt/mote/config/.secret     ← Password file (generated once)
```

The Go binary is statically compiled — no language runtime is needed on the server.

## GitHub Secrets Setup

Add the following to your repository's **Settings → Secrets and variables → Actions**:

| Secret / Variable | Description |
|---|---|
| `SSH_HOST` | Server IP or hostname |
| `SSH_USER` | SSH user with sudo access |
| `SSH_PRIVATE_KEY` | Private key content (generate with `make setup-deploy-key`) |
| `SSH_KNOWN_HOSTS` | Server fingerprint (`ssh-keyscan -p PORT HOST`) |
| `SSH_PORT` *(variable, optional)* | SSH port (default: 22) |

### Generate SSH deploy key

On the server:

```bash
make setup-deploy-key
```

This creates an ed25519 key pair in `/opt/mote/config/` and outputs the private key — paste it into the `SSH_PRIVATE_KEY` secret.

## First-time Server Setup

Run once on a fresh server:

```bash
cd /path/to/mote/deploy

# 1. Create directories and system user
make init-env

# 2. Install system packages and Redis
make install-sys
make install-redis

# 3. Configure Nginx
make setup-nginx DOMAIN=example.com

# 4. Setup HTTPS
make setup-https DOMAIN=example.com EMAIL=admin@example.com

# 5. Generate deploy key and add to GitHub Secrets
make setup-deploy-key

# 6. Push to main — GitHub Actions handles the rest
```

After the first push to `main`, GitHub Actions will:
1. Build the Go binary and frontend
2. Upload them to `/tmp/` on the server
3. Run `deploy-artifacts.sh` which installs the binary, updates static files, and starts the service

## Daily Maintenance

### Service management

```bash
make status          # Show mote + nginx status
make restart-backend # Restart Go service
make logs            # Last 50 log lines
make logs-follow     # Tail logs live
make logs-nginx      # Nginx access + error logs
```

### Backup

```bash
make backup
```

Backups go to `/opt/mote/backups/`, keeping the last 5.

### Password management

```bash
make view-password       # Show current password
make gen-password-force  # Regenerate password (restarts service)
```

### Health check

```bash
make health-check
```

### Disk usage

```bash
make disk-usage
```

## Emergency Manual Deployment

Use when GitHub Actions is unavailable and you need to deploy from the server itself:

```bash
# Install Go if not present
make install-go

# Build and deploy
make deploy-go
```

For frontend only:

```bash
make install-node
make deploy-frontend
```

## Troubleshooting

### Service won't start

```bash
make logs
make status
sudo netstat -tlnp | grep 8001   # check port conflict
```

### Frontend not loading

```bash
make status        # check nginx
make logs-nginx
sudo nginx -t      # validate config
```

### HTTPS certificate issues

```bash
sudo certbot certificates
make setup-https DOMAIN=example.com EMAIL=admin@example.com
```

### Disk space

```bash
make disk-usage
make clean          # remove deployment files (keeps data + backups)
make clean-data     # also removes data (keeps backups)
make clean-full     # removes everything
```

## Script Reference

| Script | Description |
|---|---|
| `common.sh` | Shared config (paths, ports, versions) — sourced by all scripts |
| `init-env.sh` | Create directories and `mote` system user |
| `setup-https.sh` | Obtain Let's Encrypt certificate |
| `setup-nginx.sh` | Generate and install Nginx config |
| `setup-systemd.sh` | Generate and install systemd service unit |
| `install-deps.sh` | Install sys / nodejs / go / redis |
| `deploy-artifacts.sh` | **CI-facing**: receive pre-built binary + frontend, deploy, restart |
| `deploy-frontend.sh` | Manual: build and deploy frontend from source |
| `deploy-backend.sh` | Manual/emergency: build and deploy Go backend from source |
| `gen-password.sh` | Generate `MOTE_PASSWORD` secret file |
| `get-password.sh` | Print current password |
| `backup.sh` | Backup database and uploads |
| `check-health.sh` | Health check for all services |
| `clean.sh` | Remove deployment artifacts |

