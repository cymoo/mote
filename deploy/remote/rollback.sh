#!/usr/bin/env bash
# Point `current` back at an earlier release and restart.
#
# Runs on the server as the deploy user. Needs no sudo.
#
# usage: rollback.sh <app_dir> <keep_releases> [release_id]
set -euo pipefail

APP_DIR="${1:?app_dir required}"
KEEP="${2:-5}"
TARGET="${3:-}"

[[ -L "$APP_DIR/current" ]] || { printf 'ERROR: no current release to roll back from\n' >&2; exit 1; }
current="$(basename "$(readlink "$APP_DIR/current")")"

if [[ -z $TARGET ]]; then
    TARGET="$(
        find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
            | sort -r | grep -vx "$current" | head -1 || true
    )"
fi

[[ -n $TARGET ]] || { printf 'ERROR: no other release on the server to roll back to\n' >&2; exit 1; }
[[ -d "$APP_DIR/releases/$TARGET" ]] || { printf 'ERROR: unknown release: %s\n' "$TARGET" >&2; exit 1; }

printf '    rolling back: %s -> %s\n' "$current" "$TARGET"
exec bash "$APP_DIR/bin/activate.sh" "$APP_DIR" "$TARGET" "$KEEP"
