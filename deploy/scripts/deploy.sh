#!/usr/bin/env bash
# Build locally, ship the artifacts, activate the release. No sudo, no Docker,
# no toolchain on the server.
#
#   ./deploy.sh            deploy HEAD (refuses if the working tree is dirty)
#   ./deploy.sh --dirty    deploy the working tree as-is
set -euo pipefail

# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

ALLOW_DIRTY=false
case "${1:-}" in
    --dirty) ALLOW_DIRTY=true ;;
    "") ;;
    *) die "unknown argument: $1 (expected --dirty)" ;;
esac

load_config
require_tools go yarn rsync ssh git shasum
check_ssh

sha="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
suffix=""
if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then
    $ALLOW_DIRTY || die "working tree is dirty — commit first, or deploy it anyway with: make deploy-dirty"
    suffix="-dirty"
    warn "deploying a dirty working tree; the release will be tagged $sha$suffix"
fi
RELEASE="$(date +%Y%m%d-%H%M%S)-$sha$suffix"

STAGE="$DEPLOY_DIR/.build/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"

step "Building frontend"
(
    cd "$REPO_DIR/frontend"
    yarn install --frozen-lockfile --silent
    VITE_MEMO_URL=/memo \
    VITE_BLOG_URL=/shared \
    VITE_MANIFEST_START_URL=/memo \
        yarn build
)
cp -R "$REPO_DIR/frontend/dist" "$STAGE/web"

step "Building Go binary (linux/amd64, static)"
(
    cd "$REPO_DIR/api-go"
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
        go build -trimpath -ldflags='-s -w' -o "$STAGE/mote" ./cmd/server
)
info "$(du -h "$STAGE/mote" | cut -f1) binary, $(du -sh "$STAGE/web" | cut -f1) of static assets"

step "Uploading ops scripts, config and systemd units"
sync_support_files

step "Backing up the database"
rsh "bash '$REMOTE_DIR/bin/backup.sh' '$REMOTE_DIR'"

step "Uploading release $RELEASE"
rsh "mkdir -p '$REMOTE_DIR/releases/$RELEASE'"
dest="$SSH_TARGET:$REMOTE_DIR/releases/$RELEASE/"
if rsh "test -e '$REMOTE_DIR/current'" 2> /dev/null; then
    # Most files are byte-identical between releases: Vite's asset names are
    # content-hashed, and `go build -trimpath` is reproducible. Hardlink those
    # from the previous release instead of re-uploading and re-storing them.
    #
    # --no-times --checksum is what makes this work: every build writes fresh
    # mtimes, and --link-dest only hardlinks on an exact match *including*
    # times, so plain -a silently links nothing. Comparing by content instead
    # also gives correct Last-Modified semantics — unchanged files keep the
    # previous release's timestamp, changed ones get a new one.
    rsync_to -a --no-times --checksum --delete \
        --link-dest="$REMOTE_DIR/current/" "$STAGE/" "$dest"
else
    rsync_to -a --delete "$STAGE/" "$dest"
fi

step "Activating $RELEASE"
rsh "bash '$REMOTE_DIR/bin/activate.sh' '$REMOTE_DIR' '$RELEASE' '$KEEP_RELEASES'"

check_nginx_drift

ok "Deployed $RELEASE — https://$DOMAIN"
