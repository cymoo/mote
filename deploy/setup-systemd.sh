#!/bin/bash

# Script to config systemd service

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.env"

BACKEND_LANG="$1"

if [ -z "$BACKEND_LANG" ]; then
    log_error "Usage: bash setup-systemd.sh <lang>"
    exit 1
fi

SERVICE_FILE="$DEPLOY_ROOT/config/systemd/${APP_NAME}.service"
SYSTEMD_PATH="/etc/systemd/system/${APP_NAME}.service"

log_info "Generating systemd service file..."

# Get ExecStart and WorkingDirectory based on backend language
case "$BACKEND_LANG" in
    rust|rs|go)
        EXEC_START="$DEPLOY_ROOT/api/current/mote"
        WORKING_DIR="$DEPLOY_ROOT/api/current"
        ;;
    python|py)
        EXEC_START="$DEPLOY_ROOT/api/current/.venv/bin/gunicorn -k gevent -b ${API_ADDR}:$API_PORT wsgi:app"
        WORKING_DIR="$DEPLOY_ROOT/api/current"
        ;;
    kotlin|kt)
        EXEC_START="/usr/bin/java -jar $DEPLOY_ROOT/api/current/mote.jar"
        WORKING_DIR="$DEPLOY_ROOT/api/current"
        ;;
    *)
        log_error "Supported languages: rust, go, python, kotlin"
        exit 1
        ;;
esac

# Create service file
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description="$(capitalize "$APP_NAME") Application ($(capitalize "$BACKEND_LANG") backend)"
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$WORKING_DIR
EnvironmentFile=$WORKING_DIR/.env
EnvironmentFile=$SECRET_FILE
ExecStart=$EXEC_START
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DEPLOY_ROOT/data $DEPLOY_ROOT/uploads

[Install]
WantedBy=multi-user.target
EOF

# Create symlink in systemd directory
log_info "Creating systemd symlink..."
sudo ln -sf "$SERVICE_FILE" "$SYSTEMD_PATH"

log_info "Reloading systemd daemon..."
sudo systemctl daemon-reload
sudo systemctl enable ${APP_NAME}
sudo systemctl start ${APP_NAME}
