#!/usr/bin/env bash
# Activate a release that has already been uploaded to <app_dir>/releases/<id>.
#
# Flips the `current` symlink, restarts the service, waits for /health, and
# rolls back to the previous release if it never becomes healthy.
#
# Runs on the server as the deploy user. Needs no sudo.
#
# usage: activate.sh <app_dir> <release_id> <keep_releases>
set -euo pipefail

APP_DIR="${1:?app_dir required}"
RELEASE="${2:?release_id required}"
KEEP="${3:-5}"

HEALTH_URL="http://127.0.0.1:8000/health"
HEALTH_TIMEOUT=45

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

log()  { printf '    %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ -d "$APP_DIR/releases/$RELEASE" ]] || fail "release not found: $APP_DIR/releases/$RELEASE"
[[ -x "$APP_DIR/releases/$RELEASE/mote" ]] || fail "release binary missing or not executable"
[[ -f "$APP_DIR/config/mote.env" ]] || fail "$APP_DIR/config/mote.env is missing — run \`make bootstrap\` first"
command -v redis-server > /dev/null || fail "redis-server is not installed — run \`make bootstrap\` first"

previous=""
if [[ -L "$APP_DIR/current" ]]; then
    previous="$(basename "$(readlink "$APP_DIR/current")")"
fi

# One-time migration: the old deployment ran the app in Docker on the same port.
if docker ps --format '{{.Names}}' 2> /dev/null | grep -qx 'mote-app-1'; then
    log "legacy Docker stack detected — stopping it (one-time)"
    docker compose -f "$APP_DIR/deploy/compose.yml" down
fi

systemctl --user daemon-reload
systemctl --user enable mote-redis.service mote.service > /dev/null
systemctl --user start mote-redis.service

# Atomic swap so the app is never pointed at a half-written path.
ln -sfn "releases/$RELEASE" "$APP_DIR/.current.tmp"
mv -Tf "$APP_DIR/.current.tmp" "$APP_DIR/current"
log "current -> releases/$RELEASE"

restart_and_wait() {
    systemctl --user restart mote.service
    local deadline=$((SECONDS + HEALTH_TIMEOUT))
    while (( SECONDS < deadline )); do
        if curl -fsS --max-time 3 "$HEALTH_URL" 2> /dev/null | grep -q healthy; then
            return 0
        fi
        sleep 1
    done
    return 1
}

if restart_and_wait; then
    log "healthy: $(curl -fsS --max-time 3 "$HEALTH_URL")"
else
    printf 'ERROR: %s did not become healthy within %ss\n' "$RELEASE" "$HEALTH_TIMEOUT" >&2
    systemctl --user status mote.service --no-pager --lines 20 >&2 || true

    if [[ -z $previous || ! -d "$APP_DIR/releases/$previous" ]]; then
        fail "no previous release to roll back to — the service is down, inspect with: journalctl --user -u mote -n 100"
    fi

    printf 'Rolling back to %s\n' "$previous" >&2
    ln -sfn "releases/$previous" "$APP_DIR/.current.tmp"
    mv -Tf "$APP_DIR/.current.tmp" "$APP_DIR/current"
    if restart_and_wait; then
        fail "deploy failed; rolled back to $previous, which is healthy again"
    fi
    fail "deploy failed AND rollback to $previous is also unhealthy — inspect: journalctl --user -u mote -n 100"
fi

# Keep the newest KEEP releases plus whatever `current` points at.
current_target="$(basename "$(readlink "$APP_DIR/current")")"
mapfile -t stale < <(
    find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
        | sort -r | tail -n "+$((KEEP + 1))" | grep -vx "$current_target" || true
)
if (( ${#stale[@]} > 0 )); then
    for dir in "${stale[@]}"; do
        rm -rf "${APP_DIR:?}/releases/${dir:?}"
    done
    log "pruned ${#stale[@]} old release(s), keeping $KEEP"
fi
