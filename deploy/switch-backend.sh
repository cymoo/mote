#!/bin/bash
# Script to switch backend language
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.env"

# Display usage information
usage() {
    cat <<EOF
Usage: $0 <LANG> [OPTIONS]

Arguments:
    LANG            Backend language to switch to (required)
                    Supported values: rust, go, python, kotlin

Options:
    -h, --help      Show this help message
    --force         Skip confirmation prompt

Examples:
    $0 rust
    $0 python
    $0 kotlin --force

Description:
    This script switches the active backend to the specified language.

    It will:
    - Validate the target backend exists
    - Update the symlink to point to new backend
    - Reconfigure systemd service
EOF
    exit 0
}

# Parse command line arguments
FORCE=false

if [[ $# -lt 1 ]]; then
    usage
fi

BACKEND_LANG="$1"
shift

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
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

# Validate backend language
validate_backend() {
    if [[ -z "$BACKEND_LANG" ]]; then
        log_error "Backend language cannot be empty"
        usage
    fi

    case "$BACKEND_LANG" in
        rust|go|python|kotlin)
            ;;
        *)
            log_error "Unsupported language: $BACKEND_LANG"
            log_info "Supported languages: rust, go, python, kotlin"
            exit 1
            ;;
    esac
}

# Check if backend exists
check_backend_exists() {
    local backend_dir="$DEPLOY_ROOT/api/$BACKEND_LANG"

    if [[ ! -d "$backend_dir" ]]; then
        log_error "Backend not found: $backend_dir"
        log_error "Please deploy the backend first:"
        log_error "  make deploy-backend $BACKEND_LANG"
        exit 1
    fi

    log_success "Backend found: $backend_dir"
}

# Get current backend
get_current_backend() {
    if [[ -L "$DEPLOY_ROOT/api/current" ]]; then
        local current_path=$(readlink "$DEPLOY_ROOT/api/current")
        local current_lang=$(basename "$current_path")
        echo "$current_lang"
    else
        echo ""
    fi
}

# Confirm switch if needed
confirm_switch() {
    if [[ "$FORCE" == true ]]; then
        return 0
    fi

    local current=$(get_current_backend)

    if [[ -n "$current" ]]; then
        if [[ "$current" == "$BACKEND_LANG" ]]; then
            log_warn "Already using $BACKEND_LANG backend"
            read -p "Continue anyway? [y/N] " -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                log_info "Switch cancelled"
                exit 0
            fi
        else
            log_info "Current backend: $current"
            log_info "Switching to: $BACKEND_LANG"
            read -p "Continue? [Y/n] " -r
            echo
            if [[ $REPLY =~ ^[Nn]$ ]]; then
                log_info "Switch cancelled"
                exit 0
            fi
        fi
    fi
}

# Update backend symlink
update_symlink() {
    local backend_dir="$DEPLOY_ROOT/api/$BACKEND_LANG"

    log_info "Updating backend symlink..."

    # Create new symlink
    sudo ln -sf "$backend_dir" "$DEPLOY_ROOT/api/current"

    log_success "Symlink updated: current -> $BACKEND_LANG"
}

# Reconfigure systemd service
reconfigure_systemd() {
    log_info "Reconfiguring systemd service..."

    if bash "${SCRIPT_DIR}/setup-systemd.sh" "$BACKEND_LANG"; then
        log_success "Systemd service reconfigured"
    else
        log_error "Failed to reconfigure systemd service"
        exit 1
    fi
}

# Verify backend is responding
verify_backend() {
    log_info "Verifying backend response..."

    # Give it a moment to initialize
    sleep 1

    if command -v curl &> /dev/null; then
        for endpoint in "/health" "/api/health" "/ping" "/api/ping"; do
            if curl -sf --max-time 5 "http://localhost:${API_PORT}${endpoint}" > /dev/null 2>&1; then
                log_success "Backend is responding"
                return 0
            fi
        done
        log_warn "Backend health check failed (may not have health endpoint)"
    else
        log_info "curl not available, skipping health check"
    fi
}

# Main process
main() {
    log_info "Switching to $BACKEND_LANG backend..."
    echo ""

    # Validate
    validate_backend
    check_backend_exists
    confirm_switch

    # Switch
    update_symlink
    reconfigure_systemd
    verify_backend

    # Success summary
    echo ""
    log_success "Successfully switched to $BACKEND_LANG backend!"

    local current=$(get_current_backend)
    log_info "Current backend: $current"
    log_info "Backend directory: $DEPLOY_ROOT/api/$current"
    log_info "Service name: ${APP_NAME}"
}

main "$@"
