#!/bin/sh
set -e
mkdir -p /data /uploads
chown mote:mote /data /uploads
exec su-exec mote "$@"
