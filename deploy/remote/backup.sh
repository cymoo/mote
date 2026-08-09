#!/usr/bin/env bash
# Hot-backup the SQLite database with VACUUM INTO — safe while the app runs.
#
# Uploads are deliberately NOT backed up here: on this box they are far larger
# than the free disk, so a local copy would only fill the disk it is meant to
# protect. Mirror them off-server with `make pull-uploads` instead.
#
# Runs on the server as the deploy user. Needs no sudo.
#
# usage: backup.sh <app_dir> [keep]
set -euo pipefail

APP_DIR="${1:?app_dir required}"
KEEP="${2:-10}"

DB="$APP_DIR/data/app.db"
BACKUP_DIR="$APP_DIR/backups"

[[ -f $DB ]] || { printf 'ERROR: database not found: %s\n' "$DB" >&2; exit 1; }
command -v sqlite3 > /dev/null || { printf 'ERROR: sqlite3 not installed — run `make bootstrap`\n' >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
target="$BACKUP_DIR/app-$(date +%Y%m%d-%H%M%S).db"

sqlite3 "$DB" "VACUUM INTO '$target'"
printf '    database backed up: %s (%s)\n' "$(basename "$target")" "$(du -h "$target" | cut -f1)"

mapfile -t stale < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'app-*.db' -printf '%f\n' | sort -r | tail -n "+$((KEEP + 1))")
if (( ${#stale[@]} > 0 )); then
    for f in "${stale[@]}"; do
        rm -f "${BACKUP_DIR:?}/${f:?}"
    done
    printf '    pruned %d old backup(s), keeping %d\n' "${#stale[@]}" "$KEEP"
fi
