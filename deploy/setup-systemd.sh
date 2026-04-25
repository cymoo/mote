#!/bin/bash
# setup-systemd.sh - Setup systemd service for the Go backend
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

SERVICE_FILE="$DEPLOY_ROOT/config/systemd/${APP_NAME}.service"
SYSTEMD_PATH="/etc/systemd/system/${APP_NAME}.service"

EXEC_START="$DEPLOY_ROOT/api/current/mote"
WORKING_DIR="$DEPLOY_ROOT/api/current"

validate_config() {
    if [[ ! -d "$WORKING_DIR" ]]; then
        log_error "Working directory not found: $WORKING_DIR"
        log_error "Please deploy the backend first"
        exit 1
    fi

    if [[ ! -x "$EXEC_START" ]]; then
        log_error "Executable not found or not executable: $EXEC_START"
        exit 1
    fi
}

generate_service_file() {
    log_info "Generating systemd service file..."

    sudo mkdir -p "$(dirname "$SERVICE_FILE")"

    sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=${APP_NAME^} Application (Go backend)
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${WORKING_DIR}
EnvironmentFile=${WORKING_DIR}/.env
EnvironmentFile=${SECRET_FILE}
ExecStart=${EXEC_START}
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
ReadWritePaths=${DEPLOY_ROOT}/data ${DEPLOY_ROOT}/uploads

[Install]
WantedBy=multi-user.target
EOF

    log_success "Service file generated: $SERVICE_FILE"
}

install_service() {
    log_info "Installing systemd service..."
    sudo ln -sf "$SERVICE_FILE" "$SYSTEMD_PATH"
    sudo systemctl daemon-reload
    log_success "Service installed"
}

reload_service() {
    if sudo systemctl is-active --quiet "${APP_NAME}"; then
        log_info "Restarting service..."
        sudo systemctl restart "${APP_NAME}"
    else
        log_info "Starting service..."
        sudo systemctl enable "${APP_NAME}"
        sudo systemctl start "${APP_NAME}"
    fi

    sleep 2

    if sudo systemctl is-active --quiet "${APP_NAME}"; then
        log_success "Service is running"
        sudo systemctl status "${APP_NAME}" --no-pager | head -n 10
    else
        log_error "Failed to start service"
        sudo journalctl -u "${APP_NAME}" -n 20 --no-pager
        exit 1
    fi
}

main() {
    log_info "Configuring systemd service..."
    validate_config
    generate_service_file
    install_service
    reload_service
}

main "$@"
