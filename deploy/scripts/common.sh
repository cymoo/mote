# Shared helpers for the local-driven deploy scripts.
# Sourced, never executed directly.

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"

if [[ -t 1 ]]; then
    C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'; C_RED=$'\033[0;31m'
    C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
    C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''; C_OFF=''
fi

step() { printf '%s==>%s %s\n' "$C_YELLOW" "$C_OFF" "$*"; }
info() { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
ok()   { printf '%s==>%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%sWARN:%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

load_config() {
    local file="$DEPLOY_DIR/deploy.env"
    [[ -f $file ]] || die "missing $file — copy deploy.env.example to deploy.env and fill it in"

    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a

    : "${SSH_HOST:?SSH_HOST not set in deploy.env}"
    : "${SSH_USER:?SSH_USER not set in deploy.env}"
    : "${DOMAIN:?DOMAIN not set in deploy.env}"
    SSH_PORT="${SSH_PORT:-22}"
    REMOTE_DIR="${REMOTE_DIR:-/opt/mote}"
    KEEP_RELEASES="${KEEP_RELEASES:-5}"
    UPLOADS_MIRROR="${UPLOADS_MIRROR:-$HOME/mote-backups/uploads}"
    SSH_TARGET="$SSH_USER@$SSH_HOST"

    [[ $REMOTE_DIR == /* ]] || die "REMOTE_DIR must be an absolute path, got: $REMOTE_DIR"
}

require_tools() {
    local missing=()
    for tool in "$@"; do
        command -v "$tool" > /dev/null 2>&1 || missing+=("$tool")
    done
    (( ${#missing[@]} == 0 )) || die "missing local tools: ${missing[*]}"
}

# Non-interactive remote command. Fails fast rather than prompting.
rsh() {
    ssh -p "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" "$@"
}

# Interactive remote command — use only when sudo needs to prompt for a password.
rsh_tty() {
    ssh -t -p "$SSH_PORT" "$SSH_TARGET" "$@"
}

rsync_to() {
    rsync -e "ssh -p $SSH_PORT -o BatchMode=yes" "$@"
}

check_ssh() {
    rsh true 2> /dev/null \
        || die "cannot reach $SSH_TARGET:$SSH_PORT over SSH without a password.
       Set up key-based login first: ssh-copy-id -p $SSH_PORT $SSH_TARGET"
}

# Render a template's __APP_DIR__ / __DOMAIN__ placeholders to stdout.
render() {
    sed -e "s|__APP_DIR__|$REMOTE_DIR|g" -e "s|__DOMAIN__|$DOMAIN|g" "$1"
}

# Render the config templates and upload them together with the ops scripts and
# systemd units. Cheap and idempotent — bootstrap and deploy both call it, so
# the server always runs the versions in this checkout.
sync_support_files() {
    local staging="$DEPLOY_DIR/.build/support"
    rm -rf "$staging"
    mkdir -p "$staging/config" "$staging/systemd"

    render "$DEPLOY_DIR/config/redis.conf"          > "$staging/config/redis.conf"
    render "$DEPLOY_DIR/nginx.conf"                 > "$staging/config/nginx.conf"
    render "$DEPLOY_DIR/nginx-init.conf"            > "$staging/config/nginx-init.conf"
    render "$DEPLOY_DIR/systemd/mote.service"       > "$staging/systemd/mote.service"
    render "$DEPLOY_DIR/systemd/mote-redis.service" > "$staging/systemd/mote-redis.service"

    # Set the modes here rather than with --chmod: the rsync macOS ships (2.6.9)
    # does not understand the F/D-prefixed form.
    chmod 644 "$staging"/config/* "$staging"/systemd/*

    rsh "mkdir -p '$REMOTE_DIR/bin' '$REMOTE_DIR/config' ~/.config/systemd/user"
    # No --delete anywhere here: config/ also holds the server-owned mote.env.
    rsync_to -a "$DEPLOY_DIR/remote/" "$SSH_TARGET:$REMOTE_DIR/bin/"
    rsync_to -a "$staging/config/"    "$SSH_TARGET:$REMOTE_DIR/config/"
    rsync_to -a "$staging/systemd/"   "$SSH_TARGET:.config/systemd/user/"
}

# The daily deploy runs unprivileged and cannot touch /etc/nginx, so tell the
# user when the checked-in config has drifted from what nginx is serving.
check_nginx_drift() {
    local rendered="$DEPLOY_DIR/.build/support/config/nginx.conf"
    local want have
    want="$(shasum -a 256 < "$rendered" | cut -d' ' -f1)"
    have="$(rsh "sha256sum /etc/nginx/conf.d/mote.conf 2>/dev/null | cut -d' ' -f1" || true)"

    if [[ -z $have ]]; then
        warn "nginx has no mote.conf yet — run: make bootstrap"
    elif [[ $want != "$have" ]]; then
        warn "nginx.conf in this checkout differs from /etc/nginx/conf.d/mote.conf
       The app is deployed, but the nginx change is not live. Run: make nginx"
    fi
}
