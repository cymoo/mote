#!/bin/bash
# Script to clean up deployment files
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

# Display usage information
usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Options:
    -h, --help              Show this help message
    --all                   Complete cleanup including data and uploads
    --keep-backups          Keep existing backups during cleanup
    --no-backup             Skip backup creation when using --all
    --force                 Skip confirmation prompts

Examples:
    $0                      # Clean deployment files, keep data
    $0 --all                # Complete cleanup with backup
    $0 --all --no-backup    # Complete cleanup without backup
    $0 --all --force        # Complete cleanup without prompts

Description:
    This script cleans up deployment files and optionally data.

    Default behavior:
    - Stop and remove services
    - Remove Nginx configuration
    - Clean backend and frontend files
    - Keep data, uploads, and passwords

    With --all flag:
    - Additionally removes data and uploads
    - Creates backup by default
    - Optionally removes entire deployment directory
EOF
    exit 0
}

# Parse command line options
CLEAN_ALL=false
KEEP_BACKUPS=false
NO_BACKUP=false
FORCE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            ;;
        --all)
            CLEAN_ALL=true
            shift
            ;;
        --keep-backups)
            KEEP_BACKUPS=true
            shift
            ;;
        --no-backup)
            NO_BACKUP=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        *)
            log_error "Unknown option: $1"
            usage
            ;;
    esac
done

# Stop and remove service
stop_service() {
    if sudo systemctl is-active --quiet "${APP_NAME}"; then
        log_info "Stopping service..."
        sudo systemctl stop "${APP_NAME}"
        sudo systemctl disable "${APP_NAME}"
        log_success "Service stopped"
    else
        log_info "Service not running"
    fi
}

# Remove systemd service file
remove_systemd() {
    local service_file="/etc/systemd/system/${APP_NAME}.service"

    if [[ -f "$service_file" ]]; then
        log_info "Removing systemd service..."
        sudo rm -f "$service_file"
        sudo systemctl daemon-reload
        log_success "Systemd service removed"
    else
        log_info "Systemd service file not found"
    fi
}

# Remove Nginx configuration
remove_nginx() {
    local enabled="/etc/nginx/sites-enabled/${APP_NAME}.conf"
    local available="/etc/nginx/sites-available/${APP_NAME}.conf"

    if [[ -f "$enabled" ]] || [[ -f "$available" ]]; then
        log_info "Removing Nginx configuration..."
        sudo rm -f "$enabled" "$available"

        # Reload Nginx if running
        if sudo systemctl is-active --quiet nginx; then
            sudo systemctl restart nginx 2>/dev/null || true
        fi

        log_success "Nginx configuration removed"
    else
        log_info "Nginx configuration not found"
    fi
}

# Clean backend files
clean_backend() {
    log_info "Cleaning backend files..."

    local cleaned=0
    local langs=(rust go python kotlin)

    for lang in "${langs[@]}"; do
        if [[ -d "$DEPLOY_ROOT/api/$lang" ]]; then
            sudo rm -rf "$DEPLOY_ROOT/api/$lang"
            cleaned=$((cleaned + 1))
        fi
    done

    if [[ -L "$DEPLOY_ROOT/api/current" ]]; then
        sudo rm -f "$DEPLOY_ROOT/api/current"
    fi

    if [[ $cleaned -gt 0 ]]; then
        log_success "Cleaned $cleaned backend(s)"
    else
        log_info "No backend files to clean"
    fi
}

# Clean frontend files
clean_frontend() {
    log_info "Cleaning frontend files..."

    local cleaned=0
    local dirs=("$DEPLOY_ROOT/web/build" "$DEPLOY_ROOT/web/static")

    for dir in "${dirs[@]}"; do
        if [[ -d "$dir" ]]; then
            sudo rm -rf "$dir"
            cleaned=$((cleaned + 1))
        fi
    done

    if [[ $cleaned -gt 0 ]]; then
        log_success "Frontend files cleaned"
    else
        log_info "No frontend files to clean"
    fi
}

# Clean configuration files
clean_configs() {
    log_info "Cleaning configuration files..."

    local cleaned=0
    local dirs=("$DEPLOY_ROOT/config/nginx" "$DEPLOY_ROOT/config/systemd")

    for dir in "${dirs[@]}"; do
        if [[ -d "$dir" ]]; then
            sudo rm -rf "$dir"
            cleaned=$((cleaned + 1))
        fi
    done

    if [[ $cleaned -gt 0 ]]; then
        log_success "Configuration files cleaned"
    else
        log_info "No configuration files to clean"
    fi
}

# Create backup of data and uploads
create_backup() {
    if [[ "$NO_BACKUP" == true ]]; then
        log_info "Skipping backup (--no-backup)"
        return 0
    fi

    bash "${SCRIPT_DIR}/backup.sh"
}

# Clean data files
clean_data() {
    log_info "Cleaning data files..."

    local cleaned=0
    local items=(
        "$DEPLOY_ROOT/data"
        "$DEPLOY_ROOT/uploads"
        "$DEPLOY_ROOT/config/.password"
    )

    for item in "${items[@]}"; do
        if [[ -e "$item" ]]; then
            sudo rm -rf "$item"
            cleaned=$((cleaned + 1))
        fi
    done

    if [[ $cleaned -gt 0 ]]; then
        log_success "Data files cleaned"
    else
        log_info "No data files to clean"
    fi
}

# Remove entire deployment directory
remove_deploy_root() {
    if [[ ! -d "$DEPLOY_ROOT" ]]; then
        log_info "Deployment directory not found"
        return 0
    fi

    if [[ "$FORCE" == true ]]; then
        log_warn "Force mode: removing deployment directory..."
        sudo rm -rf "$DEPLOY_ROOT"
        log_success "Deployment directory removed"
        return 0
    fi

    echo ""
    log_warn "This will permanently delete: $DEPLOY_ROOT"
    read -rp "Are you sure you want to delete the entire deployment directory? [y/N] " reply
    echo

    if [[ $reply =~ ^[Yy]$ ]]; then
        log_info "Removing deployment directory..."
        sudo rm -rf "$DEPLOY_ROOT"
        log_success "Deployment directory removed"
    else
        log_info "Keeping deployment directory"
    fi
}

# Main cleanup process
main() {
    log_warn "Starting cleanup..."
    echo ""

    # Basic cleanup (always performed)
    stop_service
    remove_systemd
    remove_nginx
    clean_backend
    clean_frontend
    clean_configs

    # Full cleanup (with --all flag)
    if [[ "$CLEAN_ALL" == true ]]; then
        log_warn "Performing complete cleanup (including data and uploads)..."
        echo ""

        create_backup
        clean_data

        # Optionally remove entire deployment directory
        if [[ "$KEEP_BACKUPS" == false ]]; then
            remove_deploy_root
        else
            log_info "Keeping deployment directory and backups (--keep-backups)"
        fi
    else
        log_info "Keeping data, uploads, and passwords"
        log_info "For complete cleanup, use: $0 --all"
    fi

    echo ""
    log_success "Cleanup completed!"
}

main "$@"
