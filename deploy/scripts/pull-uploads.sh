#!/usr/bin/env bash
# Mirror the server's uploads/ directory to this machine.
#
# Uploads are far larger than the server's free disk, so they are deliberately
# left out of the on-server backups; this is how you keep a copy of them.
# Incremental — only changed files are transferred.
set -euo pipefail

# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

load_config
require_tools rsync ssh
check_ssh

mkdir -p "$UPLOADS_MIRROR"

remote_size="$(rsh "du -sh '$REMOTE_DIR/uploads' | cut -f1")"
step "Mirroring $remote_size of uploads into $UPLOADS_MIRROR"
info "--delete is on: files removed on the server are removed from the mirror too"

rsync_to -a --delete --progress "$SSH_TARGET:$REMOTE_DIR/uploads/" "$UPLOADS_MIRROR/"

ok "Mirror up to date: $UPLOADS_MIRROR"
