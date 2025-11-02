#!/bin/bash
# Script to clean up deployment files
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.env"

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
        log_info "Systemd service not found"
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
            sudo systemctl reload nginx 2>/dev/null || true
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
    for lang in rust go python kotlin; do
        if [[ -d "$DEPLOY_ROOT/api/$lang" ]]; then
            sudo rm -rf "$DEPLOY_ROOT/api/$lang"
            ((cleaned++))
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

    if [[ -d "$DEPLOY_ROOT/web/build" ]]; then
        sudo rm -rf "$DEPLOY_ROOT/web/build"
        ((cleaned++))
    fi

    if [[ -d "$DEPLOY_ROOT/web/static" ]]; then
        sudo rm -rf "$DEPLOY_ROOT/web/static"
        ((cleaned++))
    fi

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

    if [[ -d "$DEPLOY_ROOT/config/nginx" ]]; then
        sudo rm -rf "$DEPLOY_ROOT/config/nginx"
        ((cleaned++))
    fi

    if [[ -d "$DEPLOY_ROOT/config/systemd" ]]; then
        sudo rm -rf "$DEPLOY_ROOT/config/systemd"
        ((cleaned++))
    fi

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

    local has_data=false

    # Check if there's anything to backup
    if sudo test -f "$DB_PATH"; then
        has_data=true
    fi

    if [[ -d "$UPLOADS_DIR" ]] && [[ -n "$(sudo ls -A "$UPLOADS_DIR" 2>/dev/null)" ]]; then
        has_data=true
    fi

    if [[ "$has_data" == false ]]; then
        log_info "No data to backup"
        return 0
    fi

    local backup_name="full-backup-$(date +%Y%m%d-%H%M%S)"
    local backup_path="$DEPLOY_ROOT/backups/$backup_name"

    log_info "Creating backup: $backup_name"
    sudo mkdir -p "$backup_path"

    # Backup database
    if sudo test -f "$DB_PATH"; then
        sudo cp "$DB_PATH" "$backup_path/"
        log_info "Database backed up"
    fi

    # Backup uploads
    if [[ -d "$UPLOADS_DIR" ]] && [[ -n "$(sudo ls -A "$UPLOADS_DIR" 2>/dev/null)" ]]; then
        sudo cp -r "$UPLOADS_DIR" "$backup_path/"
        log_info "Uploads backed up"
    fi

    log_success "Backup created: $backup_path"
}

# Clean data files
clean_data() {
    log_info "Cleaning data files..."

    local cleaned=0

    if [[ -d "$DEPLOY_ROOT/data" ]]; then
        sudo rm -rf "$DEPLOY_ROOT/data"
        ((cleaned++))
    fi

    if [[ -d "$DEPLOY_ROOT/uploads" ]]; then
        sudo rm -rf "$DEPLOY_ROOT/uploads"
        ((cleaned++))
    fi

    if [[ -f "$DEPLOY_ROOT/config/.password" ]]; then
        sudo rm -f "$DEPLOY_ROOT/config/.password"
        ((cleaned++))
    fi

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
    read -p "Are you sure you want to delete the entire deployment directory? [y/N] " -r
    echo

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log_info "Removing deployment directory..."
        sudo rm -rf "$DEPLOY_ROOT"
        log_success "Deployment directory removed"
    else
        log_info "Keeping deployment directory"
    fi
}

# Show backup information
show_backup_info() {
    if [[ -d "$DEPLOY_ROOT/backups" ]]; then
        local backup_count=$(sudo ls -1 "$DEPLOY_ROOT/backups" 2>/dev/null | wc -l)

        if [[ $backup_count -gt 0 ]]; then
            log_info "Existing backups: $backup_count"
            log_info "Backup location: $DEPLOY_ROOT/backups"

            # Show most recent backup
            local latest=$(sudo ls -1t "$DEPLOY_ROOT/backups" 2>/dev/null | head -n 1)
            if [[ -n "$latest" ]]; then
                log_info "Latest backup: $latest"
            fi
        fi
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

    # Show backup info if directory still exists
    show_backup_info
}

main "$@"
