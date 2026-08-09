#!/usr/bin/env bash
# Push nginx.conf to the server and reload. Prompts for the remote sudo
# password — the only routine task that needs it.
set -euo pipefail

# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

load_config
require_tools rsync ssh
check_ssh

step "Uploading rendered nginx.conf"
sync_support_files

step "Installing and reloading nginx (remote sudo password required)"
rsh_tty "bash '$REMOTE_DIR/bin/install-nginx.sh' '$REMOTE_DIR'"

ok "nginx updated for $DOMAIN"
