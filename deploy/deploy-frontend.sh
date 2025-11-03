#!/bin/bash
# Script to deploy the frontend application
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.env"

FRONTEND_SRC="${PROJECT_ROOT}/frontend"

# Display usage information
usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Options:
    -h, --help              Show this help message
    --skip-install          Skip dependency installation
    --skip-build            Skip build step (use existing dist/)
    --no-reload             Don't reload Nginx after deployment

Examples:
    $0
    $0 --skip-install
    $0 --skip-build --no-reload

Description:
    This script builds and deploys the frontend application.
    It will:
    - Install dependencies (via yarn)
    - Build the frontend using Vite
    - Deploy built files to the web directory
    - Set proper permissions
    - Reload Nginx if configured
EOF
    exit 0
}

# Default options
SKIP_INSTALL=false
SKIP_BUILD=false
NO_RELOAD=false

# Parse command line options
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            ;;
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --no-reload)
            NO_RELOAD=true
            shift
            ;;
        *)
            log_error "Unknown option: $1"
            usage
            ;;
    esac
done

check_not_root

# Validate source directory
validate_source() {
    if [[ ! -d "$FRONTEND_SRC" ]]; then
        log_error "Frontend source directory not found: $FRONTEND_SRC"
        exit 1
    fi

    cd "$FRONTEND_SRC"

    if [[ ! -f "package.json" ]]; then
        log_error "package.json not found in: $FRONTEND_SRC"
        exit 1
    fi
}

# Check if required commands are available
check_dependencies() {
    if ! check_command npx; then
        # TODO: install npx if not present
        log_error "npx is not installed. Please install Node.js first."
        exit 1
    fi
}

# Install frontend dependencies
install_dependencies() {
    if [[ "$SKIP_INSTALL" == true ]]; then
        log_info "Skipping dependency installation (--skip-install)"
        return 0
    fi

    log_info "Installing frontend dependencies..."

    if [[ -f "yarn.lock" ]]; then
        npx yarn install --frozen-lockfile --silent
    elif [[ -f "package-lock.json" ]]; then
        npm ci --silent
    else
        npm install --silent
    fi

    log_success "Dependencies installed"
}

# Build frontend application
build_frontend() {
    if [[ "$SKIP_BUILD" == true ]]; then
        log_info "Skipping build step (--skip-build)"

        # Verify dist directory exists
        if [[ ! -d "dist" ]]; then
            log_error "dist directory not found. Cannot skip build."
            exit 1
        fi
        return 0
    fi

    log_info "Building frontend..."

    # Set environment variables for build
    export VITE_MEMO_URL="$MEMO_URL"
    export VITE_BLOG_URL="$BLOG_URL"
    export VITE_MANIFEST_START_URL="$MEMO_URL"

    # Run build
    if npx vite build --logLevel error; then
        log_success "Build completed successfully"
    else
        log_error "Build failed"
        exit 1
    fi

    # Verify build output
    if [[ ! -d "dist" ]]; then
        log_error "Build failed: dist directory not found"
        exit 1
    fi

    # Check if dist directory is not empty
    if [[ -z "$(ls -A dist)" ]]; then
        log_error "Build failed: dist directory is empty"
        exit 1
    fi
}

# Deploy built files
deploy_files() {
    log_info "Deploying build files to: $WEB_DIR"

    # Create destination directory
    sudo mkdir -p "$WEB_DIR/build"

    # Backup existing build if it exists
    if [[ -d "$WEB_DIR/build" ]] && [[ -n "$(ls -A "$WEB_DIR/build")" ]]; then
        log_info "Backing up existing build..."
        sudo mv "$WEB_DIR/build" "$WEB_DIR/build.backup.$(date +%Y%m%d_%H%M%S)"
        sudo mkdir -p "$WEB_DIR/build"
    fi

    # Copy new build files
    sudo cp -r dist/* "$WEB_DIR/build/"

    log_success "Files deployed successfully"
}

# Set file permissions
set_permissions() {
    log_info "Setting permissions..."

    ensure_user_exists "$APP_USER"
    sudo chown -R "$APP_USER:$APP_USER" "$WEB_DIR"
    sudo chmod -R 755 "$WEB_DIR"

    log_success "Permissions configured"
}

# Clean up old backups (keep last 3)
cleanup_backups() {
    local backup_count=$(sudo find "$WEB_DIR" -maxdepth 1 -name "build.backup.*" -type d | wc -l)

    if [[ $backup_count -gt 3 ]]; then
        log_info "Cleaning up old backups (keeping last 3)..."
        sudo find "$WEB_DIR" -maxdepth 1 -name "build.backup.*" -type d |
            sort | head -n -3 | xargs -r sudo rm -rf
        log_success "Old backups cleaned up"
    fi
}

# Reload Nginx configuration
reload_nginx() {
    if [[ "$NO_RELOAD" == true ]]; then
        log_info "Skipping Nginx reload (--no-reload)"
        return 0
    fi

    # Check if Nginx is active and configured
    if ! sudo systemctl is-active --quiet nginx; then
        log_info "Nginx is not running, skipping reload"
        return 0
    fi

    if [[ ! -f "/etc/nginx/sites-enabled/${APP_NAME}.conf" ]]; then
        log_info "Nginx configuration not found, skipping reload"
        return 0
    fi

    log_info "Reloading Nginx configuration..."

    if sudo nginx -t 2>/dev/null; then
        sudo systemctl reload nginx
        log_success "Nginx reloaded successfully"
    else
        log_error "Nginx configuration test failed"
        return 1
    fi
}

# Main deployment process
main() {
    log_info "Starting frontend deployment..."

    # Validate and prepare
    validate_source
    check_dependencies

    # Build
    install_dependencies
    build_frontend

    # Deploy
    deploy_files
    set_permissions
    cleanup_backups

    # Finalize
    reload_nginx

    # Success summary
    log_success "Frontend deployed successfully!"
    log_info "Frontend files location: $WEB_DIR/build"

    # Show deployment info
    if [[ -d "$WEB_DIR/build" ]]; then
        local file_count=$(find "$WEB_DIR/build" -type f | wc -l)
        local dir_size=$(du -sh "$WEB_DIR/build" | cut -f1)
        log_info "Deployed files: $file_count files ($dir_size)"
    fi
}

main "$@"
