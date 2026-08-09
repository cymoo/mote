#!/usr/bin/env bash
# One-time server preparation, driven from here. Prompts once for the remote
# sudo password; nothing is stored and no credential ever enters this repo.
set -euo pipefail

# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

load_config
require_tools rsync ssh
check_ssh

step "Uploading ops scripts, config and systemd units"
sync_support_files

step "Preparing $SSH_TARGET (you will be asked for the remote sudo password)"
rsh_tty "bash '$REMOTE_DIR/bin/bootstrap.sh' '$REMOTE_DIR' '$DOMAIN'"
