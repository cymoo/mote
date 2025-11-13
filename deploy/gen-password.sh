#!/bin/bash
# gen-password.sh - Script to generate and manage application password
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

FORCE_REGENERATE=false

# Display usage information
usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Options:
    -f, --force    Force regenerate password even if file exists
    -h, --help     Display this help message

Examples:
    $0              # Generate password only if file doesn't exist
    $0 --force      # Force regenerate password

Note: Generated password will be saved to: $SECRET_FILE
EOF
    exit 1
}

# Parse command line arguments
parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -f|--force)
                FORCE_REGENERATE=true
                shift
                ;;
            -h|--help)
                usage
                ;;
            *)
                log_error "Unknown option: $1"
                usage
                ;;
        esac
    done
}

# Generate and save password
generate_password() {
    local password

    log_info "Generating random password..."

    # Generate a secure random password
    password=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-24)

    if [[ -z "$password" ]]; then
        log_error "Failed to generate password"
        exit 1
    fi

    # Save password to file
    echo "MOTE_PASSWORD=$password" | sudo tee "$SECRET_FILE" > /dev/null

    # Set secure permissions
    sudo chmod 600 "$SECRET_FILE"
    sudo chown root:root "$SECRET_FILE" 2>/dev/null || true

    log_success "Password saved to: $SECRET_FILE"
    log_warn "IMPORTANT: Please record this password: $password"

    return 0
}

# Main password management logic
manage_password() {
    # Check if secret file exists
    if [[ -f "$SECRET_FILE" ]]; then
        if [[ "$FORCE_REGENERATE" == true ]]; then
            log_info "Password file exists but force regeneration is enabled"
            generate_password
            sudo systemctl restart "${APP_NAME}"
        else
            log_info "Password file already exists: $SECRET_FILE"

            # Verify file permissions
            local file_perms
            file_perms=$(stat -c %a "$SECRET_FILE" 2>/dev/null || stat -f %A "$SECRET_FILE" 2>/dev/null)
            if [[ "$file_perms" != "600" ]]; then
                log_warn "Fixing file permissions..."
                sudo chmod 600 "$SECRET_FILE"
            fi
        fi
    else
        log_info "Password file does not exist, creating new one..."
        generate_password
    fi
}

# Main execution
main() {
    parse_arguments "$@"
    manage_password
}

main "$@"
