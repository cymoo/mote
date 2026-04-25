#!/bin/bash
# deploy-backend.sh - Build and deploy Go backend on the server (manual / emergency use only).
# For regular deployments, push to the main branch and let GitHub Actions handle it.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

SRC_DIR="${PROJECT_ROOT}/api-go"
DEST_DIR="${DEPLOY_ROOT}/api/go"

check_not_root

build() {
    log_info "Building Go backend..."

    if ! check_command go; then
        log_info "Go not found. Installing Go..."
        bash "${SCRIPT_DIR}/install-deps.sh" go
    fi

    export PATH=$PATH:/usr/local/go/bin
    cd "$SRC_DIR"
    go build -ldflags="-s -w" -o bin/mote ./cmd/server

    log_success "Build completed"
}

deploy() {
    log_info "Deploying Go binary..."

    sudo mkdir -p "$DEST_DIR"
    sudo cp "$SRC_DIR/bin/mote" "$DEST_DIR/mote"
    sudo chmod +x "$DEST_DIR/mote"

    sudo tee "${DEST_DIR}/.env" > /dev/null <<EOF
UPLOAD_PATH=${UPLOADS_DIR}
HTTP_PORT=${API_PORT}
HTTP_IP=${API_ADDR}
LOG_LEVEL=${LOG_LEVEL}
LOG_REQUESTS=false
APP_ENV=prod
DATABASE_URL=${DB_FILE}
EOF
    sudo chmod 600 "${DEST_DIR}/.env"

    ensure_user_exists "$APP_USER"
    sudo chown -R "$APP_USER:$APP_USER" "$DEST_DIR"
    sudo ln -sfn "$DEST_DIR" "$DEPLOY_ROOT/api/current"

    log_success "Binary deployed"
}

main() {
    log_warn "Manual deployment mode (normal path is GitHub Actions CI/CD)"
    log_info "Starting Go backend deployment..."

    if [[ ! -d "$SRC_DIR" ]]; then
        log_error "Source directory not found: $SRC_DIR"
        exit 1
    fi

    build

    if sudo systemctl is-active --quiet "${APP_NAME}"; then
        sudo systemctl stop "${APP_NAME}"
    fi

    deploy
    bash "${SCRIPT_DIR}/gen-password.sh"
    bash "${SCRIPT_DIR}/setup-systemd.sh"

    log_success "Go backend deployed!"
}

main "$@"
