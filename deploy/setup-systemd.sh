#!/bin/bash
# Script to configure systemd service
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

# Display usage information
usage() {
    cat <<EOF
Usage: $0 <LANG>

Arguments:
    LANG    Backend language for service configuration (required)
            Supported values: rust|rs, go, python|py, kotlin|kt

Examples:
    $0 rust
    $0 python
    $0 go
    $0 kotlin

Description:
    This script generates and installs systemd service configuration
    for the backend application based on the specified language.

    It will:
    - Generate appropriate ExecStart command
    - Configure working directory and environment
    - Set up security restrictions
    - Enable and start the service
EOF
    exit 1
}

# Parse command line arguments
if [[ $# -ne 1 ]]; then
    usage
fi

BACKEND_LANG="$1"

# Validate backend language
if [[ -z "$BACKEND_LANG" ]]; then
    log_error "Backend language cannot be empty"
    usage
fi

SERVICE_FILE="$DEPLOY_ROOT/config/systemd/${APP_NAME}.service"
SYSTEMD_PATH="/etc/systemd/system/${APP_NAME}.service"

# Determine execution command and working directory
get_service_config() {
    case "$BACKEND_LANG" in
        rust|rs)
            EXEC_START="$DEPLOY_ROOT/api/current/mote"
            WORKING_DIR="$DEPLOY_ROOT/api/current"
            DESCRIPTION="Rust"
            ;;
        go)
            EXEC_START="$DEPLOY_ROOT/api/current/mote"
            WORKING_DIR="$DEPLOY_ROOT/api/current"
            DESCRIPTION="Go"
            ;;
        python|py)
            EXEC_START="$DEPLOY_ROOT/api/current/.venv/bin/gunicorn -k gevent -b ${API_ADDR}:${API_PORT} wsgi:app"
            WORKING_DIR="$DEPLOY_ROOT/api/current"
            DESCRIPTION="Python"
            ;;
        kotlin|kt)
            EXEC_START="/usr/bin/java -jar $DEPLOY_ROOT/api/current/mote.jar"
            WORKING_DIR="$DEPLOY_ROOT/api/current"
            DESCRIPTION="Kotlin"
            ;;
        *)
            log_error "Unsupported language: $BACKEND_LANG"
            log_info "Supported languages: rust|rs, go, python|py, kotlin|kt"
            exit 1
            ;;
    esac
}

# Validate service configuration
validate_config() {
    if [[ ! -d "$WORKING_DIR" ]]; then
        log_error "Working directory not found: $WORKING_DIR"
        log_error "Please deploy the backend first"
        exit 1
    fi

    # Validate executable for compiled languages
    case "$BACKEND_LANG" in
        rust|rs|go)
            if [[ ! -x "$EXEC_START" ]]; then
                log_error "Executable not found or not executable: $EXEC_START"
                exit 1
            fi
            ;;
        python|py)
            if [[ ! -f "$WORKING_DIR/.venv/bin/gunicorn" ]]; then
                log_error "Gunicorn not found in virtual environment"
                exit 1
            fi
            ;;
        kotlin|kt)
            local jar_file="$DEPLOY_ROOT/api/current/mote.jar"
            if [[ ! -f "$jar_file" ]]; then
                log_error "JAR file not found: $jar_file"
                exit 1
            fi
            ;;
    esac
}

# Generate systemd service file
generate_service_file() {
    log_info "Generating systemd service file..."

    # Ensure config directory exists
    sudo mkdir -p "$(dirname "$SERVICE_FILE")"

    # Generate service file
    sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=${APP_NAME^} Application (${DESCRIPTION} backend)
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

# Install service file
install_service() {
    log_info "Installing systemd service..."

    # Create symlink in systemd directory
    sudo ln -sf "$SERVICE_FILE" "$SYSTEMD_PATH"

    # Reload systemd
    log_info "Reloading systemd daemon..."
    sudo systemctl daemon-reload

    log_success "Service installed"
}

# Enable and start service
# Reload service if running, otherwise start it
reload_service() {
    log_info "Checking service status..."

    # Check if service is already running
    if sudo systemctl is-active --quiet "${APP_NAME}"; then
        log_info "Service is already running, restarting..."
        sudo systemctl restart "${APP_NAME}"
        action="restarted"
    else
        log_info "Service is not running, enabling and starting..."
        sudo systemctl enable "${APP_NAME}"
        sudo systemctl start "${APP_NAME}"
        action="started"
    fi

    # Wait for service to be ready
    sleep 2

    # Verify service is running
    if sudo systemctl is-active --quiet "${APP_NAME}"; then
        log_success "Service ${action} successfully"
        log_info "Service status:"
        sudo systemctl status "${APP_NAME}" --no-pager | head -n 10
    else
        log_error "Failed to ${action} service"
        log_info "Service logs:"
        sudo journalctl -u "${APP_NAME}" -n 20 --no-pager
        exit 1
    fi
}

# Main process
main() {
    log_info "Configuring systemd service for ${BACKEND_LANG} backend..."

    # Setup
    get_service_config
    validate_config

    # Generate and install
    generate_service_file
    install_service
    reload_service
}

main "$@"
