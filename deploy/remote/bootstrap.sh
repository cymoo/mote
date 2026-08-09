#!/usr/bin/env bash
# One-time server preparation. This is the only script that needs sudo — every
# day-to-day target (deploy, rollback, backup, logs, restart) runs unprivileged.
#
# Idempotent: safe to re-run after changing nginx.conf or redis.conf.
#
# usage: bootstrap.sh <app_dir> <domain>
set -euo pipefail

APP_DIR="${1:?app_dir required}"
DOMAIN="${2:?domain required}"

DEPLOY_USER="$(id -un)"
ACME_CONF=/etc/nginx/conf.d/mote-acme.conf

# systemctl --user needs this to reach the user bus. A login session normally
# sets it, but don't depend on how this script was invoked.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

step() { printf '\033[0;33m==>\033[0m %s\n' "$*"; }
log()  { printf '    %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f "$APP_DIR/config/redis.conf" ]] || fail "config/redis.conf not uploaded — run this via \`make bootstrap\`"
[[ -f "$APP_DIR/config/nginx.conf" ]] || fail "config/nginx.conf not uploaded — run this via \`make bootstrap\`"

step "Installing packages (sqlite3, redis-server, redis-tools, curl)"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sqlite3 redis-server redis-tools curl

# Mote runs its own Redis as a user service against $APP_DIR/redis, so the
# distro's system-wide instance must not hold port 6379.
if systemctl is-enabled --quiet redis-server 2> /dev/null || systemctl is-active --quiet redis-server 2> /dev/null; then
    step "Disabling the system-wide redis-server (Mote runs its own user instance)"
    sudo systemctl disable --now redis-server
fi

step "Enabling lingering for $DEPLOY_USER"
# Without this, systemd --user services stop on logout and never start at boot.
sudo loginctl enable-linger "$DEPLOY_USER"

step "Tuning vm.overcommit_memory for Redis background saves"
echo 'vm.overcommit_memory = 1' | sudo tee /etc/sysctl.d/99-redis.conf > /dev/null
sudo sysctl -q -p /etc/sysctl.d/99-redis.conf

step "Preparing $APP_DIR"
mkdir -p "$APP_DIR"/{releases,bin,config,redis,data,uploads,backups}
# Older deploys ran as root and left these unwritable for the deploy user.
sudo chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/backups" "$APP_DIR/redis"
for legacy in "$APP_DIR/web"; do
    if [[ -d $legacy && ! -w $legacy ]]; then
        sudo chown -R "$DEPLOY_USER:$DEPLOY_USER" "$legacy"
        log "took ownership of legacy $legacy (safe to delete once the new layout is live)"
    fi
done

step "Setting up $APP_DIR/config/mote.env"
if [[ -f "$APP_DIR/config/mote.env" ]]; then
    log "already exists — left untouched"
elif [[ -f "$APP_DIR/deploy/.env" ]]; then
    # Migrate the secret from the old Docker Compose layout.
    install -m 600 "$APP_DIR/deploy/.env" "$APP_DIR/config/mote.env"
    log "migrated from the previous deploy/.env"
else
    printf 'MOTE_PASSWORD=change-me\n' > "$APP_DIR/config/mote.env"
    chmod 600 "$APP_DIR/config/mote.env"
    log "created a placeholder — set MOTE_PASSWORD before deploying"
fi
grep -q '^MOTE_PASSWORD=' "$APP_DIR/config/mote.env" || fail "MOTE_PASSWORD missing from $APP_DIR/config/mote.env"

step "Installing systemd user units"
systemctl --user daemon-reload
systemctl --user enable mote-redis.service mote.service > /dev/null
systemctl --user restart mote-redis.service
redis-cli -h 127.0.0.1 ping > /dev/null || fail "Redis did not come up — check: journalctl --user -u mote-redis -n 50"
log "redis is up on 127.0.0.1:6379"

step "Installing nginx config for $DOMAIN"
# /etc/letsencrypt is root-only, so this test MUST go through sudo. An
# unprivileged test always reports "missing" and would re-run the ACME dance —
# taking a working site offline — every single time.
if ! sudo test -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; then
    log "no TLS certificate for $DOMAIN yet — obtaining one via certbot"
    command -v certbot > /dev/null || fail "certbot not installed (apt install certbot)"
    sudo mkdir -p /var/www/certbot
    # Serve the challenge from its own file rather than overwriting mote.conf,
    # so an existing config is never taken down to issue a certificate.
    sudo install -m 644 "$APP_DIR/config/nginx-init.conf" "$ACME_CONF"
    sudo nginx -t && sudo systemctl reload-or-restart nginx
    sudo certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" \
        --agree-tos --non-interactive --register-unsafely-without-email \
        --keep-until-expiring --deploy-hook "systemctl reload nginx"
    sudo rm -f "$ACME_CONF"
fi

if [[ ! -e "$APP_DIR/current" ]]; then
    log "no release deployed yet — /memo will 404 until the first \`make deploy\`"
fi
bash "$APP_DIR/bin/install-nginx.sh" "$APP_DIR"

printf '\n\033[0;32m==>\033[0m Bootstrap complete. Now run: make deploy\n'
