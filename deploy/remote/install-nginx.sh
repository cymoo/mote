#!/usr/bin/env bash
# Install the rendered nginx config and reload. The only routine task that
# needs sudo, which is why it is not part of `make deploy`.
#
# The previous config is kept until `nginx -t` passes on the new one, so a bad
# config can never take the site offline.
#
# usage: install-nginx.sh <app_dir>
set -euo pipefail

APP_DIR="${1:?app_dir required}"
NGINX_CONF=/etc/nginx/conf.d/mote.conf
# conf.d only includes *.conf, so a .bak sibling is inert.
BACKUP="$NGINX_CONF.bak"

[[ -f "$APP_DIR/config/nginx.conf" ]] || { printf 'ERROR: %s/config/nginx.conf not uploaded\n' "$APP_DIR" >&2; exit 1; }

restored=false
if sudo test -f "$NGINX_CONF"; then
    sudo cp -a "$NGINX_CONF" "$BACKUP"
    restored=true
fi

sudo install -m 644 "$APP_DIR/config/nginx.conf" "$NGINX_CONF"

if ! sudo nginx -t; then
    if $restored; then
        sudo cp -a "$BACKUP" "$NGINX_CONF"
        printf 'ERROR: new config failed nginx -t; previous config restored, nginx untouched\n' >&2
    else
        sudo rm -f "$NGINX_CONF"
        printf 'ERROR: new config failed nginx -t; it has been removed\n' >&2
    fi
    exit 1
fi

sudo systemctl reload-or-restart nginx
sudo rm -f "$BACKUP"
printf '    /etc/nginx/conf.d/mote.conf updated and nginx reloaded\n'
