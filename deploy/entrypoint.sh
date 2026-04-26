#!/bin/sh
set -e
mkdir -p /data /uploads
chown -R mote:mote /data /uploads
exec su-exec mote "$@"
