#!/bin/bash
# get-password.sh - Script to view application password

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

# Check if password file exists
if [ ! -f "$SECRET_FILE" ]; then
    log_error "Password file not found: $SECRET_FILE"
    log_info "Run 'bash gen-password.sh' to generate a password first"
    exit 1
fi

# Read password (use sudo if needed)
if [ -r "$SECRET_FILE" ]; then
    PASSWORD=$(cat "$SECRET_FILE")
else
    PASSWORD=$(sudo cat "$SECRET_FILE" 2>/dev/null)
    if [ $? -ne 0 ]; then
        log_error "Failed to read password file: $SECRET_FILE"
        exit 1
    fi
fi

# Remove any 'KEY=' prefix if present
PASSWORD="${PASSWORD#*=}"

# Check if password is empty
if [ -z "$PASSWORD" ]; then
    log_error "Password file is empty: $SECRET_FILE"
    log_info "Run 'bash gen-password.sh --force' to regenerate"
    exit 1
fi

# Display password
echo ""
log_info "Application Password:"
echo ""
echo -e "  ${COLOR_BLUE}${PASSWORD}${COLOR_RESET}"
echo ""
log_warn "Keep this password secure and do not share it"
echo ""
