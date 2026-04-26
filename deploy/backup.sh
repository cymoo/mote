#!/bin/bash
# Backup SQLite database and uploads directory using Docker volumes.
# Keeps the last MAX_BACKUPS backup sets, removing older ones.
# Must be run from the deploy/ directory (where compose.yml lives).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR}/../backups"
MAX_BACKUPS=5

timestamp=$(date +%Y%m%d-%H%M%S)
backup_path="${BACKUP_DIR}/backup-${timestamp}"
backed_up=false

mkdir -p "$backup_path"

cd "$SCRIPT_DIR"

# Database: safe hot backup via VACUUM INTO (works while app is running)
if docker compose exec -T app sqlite3 /data/app.db "VACUUM INTO '/tmp/app.db'" 2>/dev/null; then
    docker compose cp app:/tmp/app.db "${backup_path}/app.db"
    docker compose exec -T app rm /tmp/app.db
    echo "[INFO] Database backed up ($(du -h "${backup_path}/app.db" | cut -f1))"
    backed_up=true
fi

# Uploads directory: backup directly from bind-mount path on host
UPLOADS_DIR="${SCRIPT_DIR}/../uploads"
if [[ -d "$UPLOADS_DIR" ]] && [[ -n "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]]; then
    tar -czf "${backup_path}/uploads.tar.gz" -C "${SCRIPT_DIR}/.." uploads
    echo "[INFO] Uploads backed up ($(du -h "${backup_path}/uploads.tar.gz" | cut -f1))"
    backed_up=true
fi

if [[ "$backed_up" == false ]]; then
    rm -rf "$backup_path"
    echo "[INFO] Nothing to backup"
    exit 0
fi

echo "[INFO] Backup created: backup-${timestamp}"

# Rotate: keep only the most recent MAX_BACKUPS
count=$(find "$BACKUP_DIR" -maxdepth 1 -type d -name "backup-*" | wc -l)
if (( count > MAX_BACKUPS )); then
    to_delete=$(( count - MAX_BACKUPS ))
    find "$BACKUP_DIR" -maxdepth 1 -type d -name "backup-*" | sort | head -n "$to_delete" | xargs rm -rf
    echo "[INFO] Removed $to_delete old backup(s), keeping ${MAX_BACKUPS}"
fi
