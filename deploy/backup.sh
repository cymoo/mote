#!/bin/bash
# Backup SQLite database and uploads directory.
# Keeps the last MAX_BACKUPS backup sets, removing older ones.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${REPO_ROOT}/backups"
DB_FILE="${REPO_ROOT}/data/app.db"
UPLOADS_DIR="${REPO_ROOT}/uploads"
MAX_BACKUPS=5

if ! command -v sqlite3 &>/dev/null; then
    echo "[ERROR] sqlite3 is not installed" >&2
    exit 1
fi

timestamp=$(date +%Y%m%d-%H%M%S)
backup_path="${BACKUP_DIR}/backup-${timestamp}"
backed_up=false

mkdir -p "$backup_path"

# Database: safe hot backup via VACUUM INTO (works while app is running)
if [[ -f "$DB_FILE" ]]; then
    sqlite3 "$DB_FILE" "VACUUM INTO '${backup_path}/app.db'"
    echo "[INFO] Database backed up ($(du -h "${backup_path}/app.db" | cut -f1))"
    backed_up=true
fi

# Uploads directory
if [[ -d "$UPLOADS_DIR" ]] && [[ -n "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]]; then
    tar -czf "${backup_path}/uploads.tar.gz" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"
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
