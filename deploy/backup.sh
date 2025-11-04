#!/bin/bash
# backup.sh - Standalone backup script for SQLite database and uploads
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

# Backup SQLite database using VACUUM INTO
backup_database() {
    local backup_file="$1"

    if ! command -v sqlite3 &> /dev/null; then
        log_error "sqlite3 command not found"
        exit 1
    fi

    if sudo sqlite3 "$DB_FILE" "VACUUM INTO '${backup_file}'" 2>&1; then
        log_info "Database backed up: $(sudo du -h "$backup_file" | cut -f1)"
        return 0
    else
        return 1
    fi
}

# Backup uploads directory
backup_uploads() {
    local backup_dir="$1"

    # Check if directory exists and is readable
    if [[ ! -d "$UPLOADS_DIR" ]]; then
        return 1
    fi

    # Check if directory is empty (handle permission errors)
    if ! sudo test -n "$(sudo ls -A "$UPLOADS_DIR" 2>/dev/null)"; then
        return 1
    fi

    if sudo cp -r "$UPLOADS_DIR" "${backup_dir}/"; then
        log_info "Uploads backed up: $(sudo du -sh "$UPLOADS_DIR" | cut -f1)"
        return 0
    else
        log_error "Uploads backup failed"
        return 1
    fi
}

# Clean old backups
cleanup_old_backups() {
    local count=$(sudo find "${BACKUP_DIR}" -maxdepth 1 -type d -name "backup-*" 2>/dev/null | wc -l)

    if [[ $count -gt $MAX_BACKUPS ]]; then
        # Use null-delimited output to handle spaces in paths
        sudo find "${BACKUP_DIR}" -maxdepth 1 -type d -name "backup-*" -print0 | \
            sort -z | head -z -n -${MAX_BACKUPS} | \
            xargs -0 sudo rm -rf
        log_info "Cleaned up $((count - MAX_BACKUPS)) old backup(s)"
    fi
}

# Main backup function
main() {
    local timestamp=$(date +%Y%m%d-%H%M%S)
    local backup_name="backup-${timestamp}"
    local backup_path="${BACKUP_DIR}/${backup_name}"

    local has_data=false

    # Create backup directory with sudo
    if ! sudo mkdir -p "$backup_path"; then
        log_error "Failed to create backup directory"
        exit 1
    fi

    # Backup database
    if backup_database "${backup_path}/app.db"; then
        has_data=true
    fi

    # Backup uploads
    if backup_uploads "$backup_path"; then
        has_data=true
    fi

    if [[ "$has_data" == false ]]; then
        sudo rm -rf "$backup_path"
        log_info "No data to backup"
        return 0
    fi

    # Create metadata
    cat <<EOF | sudo tee "${backup_path}/info.txt" > /dev/null
Date: $(date '+%Y-%m-%d %H:%M:%S')
Size: $(sudo du -sh "$backup_path" | cut -f1)
EOF

    log_success "Backup created: $backup_name"

    cleanup_old_backups
}

main "$@"
