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
    --data                  Also remove db file and uploads
    --backups               Also remove backup files
    --force                 Skip confirmation prompts

Examples:
    $0                      # Clean deployment files only
    $0 --data               # Clean deployment files and data
    $0 --data --backups     # Clean everything including backups
    $0 --data --force       # Clean data without confirmation

Description:
    This script cleans up deployment files.

    Default behavior:
    - Stop and remove services
    - Remove Nginx configuration
    - Clean backend and frontend files
    - Keep data, uploads, passwords, and backups

    With --data flag:
    - Additionally removes data and uploads
    - Still keeps backups unless --backups is specified

    With --backups flag:
    - Removes backup directory (requires confirmation unless --force)
EOF
    exit 0
}

# Parse command line options
CLEAN_DATA=false
CLEAN_BACKUPS=false
FORCE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            ;;
        --data)
            CLEAN_DATA=true
            shift
            ;;
        --backups)
            CLEAN_BACKUPS=true
            shift
            ;;
        --force|-f)
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
    local dirs=("${WEB_DIR}/build" "${WEB_DIR}/static")

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
    local dirs=("${CONFIG_DIR}/nginx" "${CONFIG_DIR}/systemd")

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

# Clean data files
clean_data() {
    if [[ "$FORCE" == false ]]; then
        echo ""
        log_warn "This will permanently delete data, uploads, and passwords"
        read -rp "Are you sure you want to delete all data? [y/N] " reply
        echo

        if [[ ! $reply =~ ^[Yy]$ ]]; then
            log_info "Skipping data cleanup"
            return 0
        fi
    fi

    log_info "Cleaning data files..."

    local cleaned=0
    local items=(
        "${DATA_DIR}"
        "${UPLOADS_DIR}"
        "${SECRET_FILE}"
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

# Clean backup files
clean_backups() {
    if [[ ! -d "${BACKUP_DIR}" ]]; then
        log_info "No backup directory found"
        return 0
    fi

    if [[ "$FORCE" == false ]]; then
        echo ""
        log_warn "This will permanently delete all backups in: ${BACKUP_DIR}"
        read -rp "Are you sure you want to delete all backups? [y/N] " reply
        echo

        if [[ ! $reply =~ ^[Yy]$ ]]; then
            log_info "Keeping backups"
            return 0
        fi
    fi

    log_info "Removing backup directory..."
    sudo rm -rf "${BACKUP_DIR}"
    log_success "Backups removed"
}

# Remove empty deployment directory if everything is cleaned
cleanup_empty_directory() {
    if [[ ! -d "$DEPLOY_ROOT" ]]; then
        return 0
    fi

    # Check if directory is empty or only contains empty subdirectories
    if [[ -z "$(find "$DEPLOY_ROOT" -type f 2>/dev/null)" ]]; then
        log_info "Removing empty deployment directory..."
        sudo rm -rf "$DEPLOY_ROOT"
        log_success "Deployment directory removed"
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

    # Optional data cleanup
    if [[ "$CLEAN_DATA" == true ]]; then
        clean_data
    else
        log_info "Keeping data, uploads, and passwords (use --data to remove)"
    fi

    # Optional backup cleanup
    if [[ "$CLEAN_BACKUPS" == true ]]; then
        clean_backups
    else
        log_info "Keeping backups (use --backups to remove)"
    fi

    # Remove deployment directory if empty
    if [[ "$CLEAN_DATA" == true ]] && [[ "$CLEAN_BACKUPS" == true ]]; then
        cleanup_empty_directory
    fi

    echo ""
    log_success "Cleanup completed!"
}

main "$@"
