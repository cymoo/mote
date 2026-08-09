#!/usr/bin/env bash
# Small remote operations that need no build: status, backup, rollback,
# restart, logs, shell. None of them need sudo.
#
# usage: ops.sh <command> [args...]
set -euo pipefail

# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

load_config
require_tools ssh
check_ssh

# systemctl --user needs this; non-login SSH sessions do not always export it.
sd='export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}";'

case "${1:-status}" in
    status)   rsh "$sd bash '$REMOTE_DIR/bin/status.sh' '$REMOTE_DIR'" ;;
    backup)   rsh "bash '$REMOTE_DIR/bin/backup.sh' '$REMOTE_DIR'" ;;
    rollback) rsh "$sd bash '$REMOTE_DIR/bin/rollback.sh' '$REMOTE_DIR' '$KEEP_RELEASES' '${2:-}'" ;;
    restart)  rsh "$sd systemctl --user restart mote.service && $sd systemctl --user is-active mote.service" ;;
    logs)     rsh_tty "$sd journalctl --user -u mote.service -n 200 -f" ;;
    shell)    rsh_tty "cd '$REMOTE_DIR' && exec \$SHELL -l" ;;
    *)        die "unknown command: $1" ;;
esac
