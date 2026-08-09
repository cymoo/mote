#!/usr/bin/env bash
# Show what is running and which releases are available.
#
# usage: status.sh <app_dir>
set -uo pipefail

APP_DIR="${1:?app_dir required}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

current="$(basename "$(readlink "$APP_DIR/current" 2> /dev/null)" 2> /dev/null || true)"

printf 'current release  %s\n' "${current:-<none>}"
printf 'mote             %s\n' "$(systemctl --user is-active mote.service 2>&1)"
printf 'mote-redis       %s\n' "$(systemctl --user is-active mote-redis.service 2>&1)"
printf 'health           %s\n' "$(curl -fsS --max-time 3 http://127.0.0.1:8000/health 2> /dev/null || echo unreachable)"
printf 'redis keys       %s\n' "$(redis-cli -h 127.0.0.1 dbsize 2> /dev/null || echo unreachable)"
printf 'database         %s\n' "$(du -h "$APP_DIR/data/app.db" 2> /dev/null | cut -f1 || echo '<none>')"
printf 'uploads          %s\n' "$(du -sh "$APP_DIR/uploads" 2> /dev/null | cut -f1 || echo '<none>')"
printf 'disk             %s used, %s free\n' \
    "$(df -h "$APP_DIR" | awk 'NR==2 {print $5}')" "$(df -h "$APP_DIR" | awk 'NR==2 {print $4}')"

printf '\nreleases (newest first)\n'
find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2> /dev/null | sort -r | while read -r r; do
    if [[ $r == "$current" ]]; then printf '  * %s\n' "$r"; else printf '    %s\n' "$r"; fi
done
