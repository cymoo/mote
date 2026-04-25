#!/bin/bash
# deploy-artifacts.sh - Deploy pre-built artifacts uploaded by GitHub Actions CI.
# Called remotely via SSH after binary and frontend are uploaded to /tmp.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

BINARY_SRC="/tmp/mote-new"
FRONTEND_SRC="/tmp/mote-frontend"
DEST_DIR="${DEPLOY_ROOT}/api/go"

deploy_binary() {
    if [[ ! -f "$BINARY_SRC" ]]; then
        log_error "Binary not found: $BINARY_SRC"
        exit 1
    fi

    log_info "Deploying Go binary..."

    sudo mkdir -p "$DEST_DIR"

    # Write env config if not present
    local env_file="${DEST_DIR}/.env"
    if [[ ! -f "$env_file" ]]; then
        sudo tee "$env_file" > /dev/null <<EOF
UPLOAD_PATH=${UPLOADS_DIR}
HTTP_PORT=${API_PORT}
HTTP_IP=${API_ADDR}
LOG_LEVEL=${LOG_LEVEL}
LOG_REQUESTS=false
APP_ENV=prod
DATABASE_URL=${DB_FILE}
EOF
        sudo chmod 600 "$env_file"
        sudo chown "${APP_USER}:${APP_USER}" "$env_file"
    fi

    sudo mv "$BINARY_SRC" "$DEST_DIR/mote"
    sudo chmod +x "$DEST_DIR/mote"
    sudo chown "${APP_USER}:${APP_USER}" "$DEST_DIR/mote"
    sudo ln -sfn "$DEST_DIR" "$DEPLOY_ROOT/api/current"

    log_success "Binary deployed"
}

restart_service() {
    log_info "Restarting backend service..."

    if sudo systemctl is-active --quiet "${APP_NAME}"; then
        sudo systemctl restart "${APP_NAME}"
    else
        bash "${SCRIPT_DIR}/setup-systemd.sh"
    fi

    sleep 2

    if sudo systemctl is-active --quiet "${APP_NAME}"; then
        log_success "Service is running"
    else
        log_error "Service failed to start"
        sudo journalctl -u "${APP_NAME}" -n 20 --no-pager
        exit 1
    fi
}

deploy_frontend() {
    if [[ ! -d "$FRONTEND_SRC" ]]; then
        log_warn "Frontend not found at $FRONTEND_SRC, skipping"
        return 0
    fi

    log_info "Deploying frontend..."

    sudo rm -rf "$WEB_DIR/build"
    sudo mkdir -p "$WEB_DIR/build"
    sudo cp -r "$FRONTEND_SRC/." "$WEB_DIR/build/"
    sudo chown -R "${APP_USER}:${APP_USER}" "$WEB_DIR/build"
    sudo chmod -R 755 "$WEB_DIR/build"

    if sudo systemctl is-active --quiet nginx; then
        if sudo nginx -t 2>/dev/null; then
            sudo systemctl reload nginx
            log_success "Nginx reloaded"
        else
            log_error "Nginx config test failed, skipping reload"
        fi
    fi

    log_success "Frontend deployed"
}

cleanup() {
    rm -rf "$FRONTEND_SRC"
    log_info "Temp files cleaned up"
}

main() {
    log_info "Deploying CI artifacts..."

    deploy_binary
    restart_service
    deploy_frontend
    cleanup

    log_success "Deployment completed!"
}

main "$@"
