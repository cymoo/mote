#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

ensure_user_exists "$APP_USER"

# Create directories
sudo mkdir -p \
  "${API_DIR}" \
  "${WEB_DIR}"/{build,static} \
  "${DATA_DIR}" \
  "${UPLOADS_DIR}" \
  "${CONFIG_DIR}"/{nginx,systemd} \
  "${BACKUP_DIR}" \
  /etc/nginx/sites-{available,enabled}

# Set permissions in batch
sudo chmod 755 "${DEPLOY_ROOT}" "${API_DIR}" "${WEB_DIR}" "${WEB_DIR}"/{build,static} "${UPLOADS_DIR}" "${BACKUP_DIR}"
sudo chmod 700 "${DATA_DIR}"
sudo chmod 750 "${CONFIG_DIR}" "${CONFIG_DIR}"/{nginx,systemd}

# Set ownership
sudo chown -R "${APP_USER}:${APP_USER}" "${DEPLOY_ROOT}"
