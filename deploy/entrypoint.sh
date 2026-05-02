#!/bin/sh
set -e
PUID=${PUID:-1000}
PGID=${PGID:-1000}
mkdir -p /data /uploads
chown "$PUID:$PGID" /data /uploads
exec su-exec "$PUID:$PGID" "$@"
