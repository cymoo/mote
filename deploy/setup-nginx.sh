#!/bin/bash

# Script to setup Nginx configuration

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.env"

# Display usage information
usage() {
    cat <<EOF
Usage: $0 <SERVER_NAME>

Arguments:
    SERVER_NAME    Domain name for Nginx configuration (required)

Example:
    $0 example.com

Description:
    This script generates and installs Nginx configuration for the specified domain.
    It will:
    - Generate configuration from template
    - Create symlink in sites-enabled
    - Remove default Nginx configuration
    - Test and reload Nginx
EOF
    exit 1
}

# Parse command line arguments
if [[ $# -ne 1 ]]; then
    usage
fi

SERVER_NAME="$1"

# Validate SERVER_NAME
if [[ -z "$SERVER_NAME" ]]; then
    log_error "SERVER_NAME cannot be empty"
    usage
fi

NGINX_TEMPLATE="${SCRIPT_DIR}/nginx.template"
NGINX_CONFIG="${CONFIG_DIR}/nginx/${APP_NAME}.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/${APP_NAME}.conf"

# Validate template file exists
validate_template() {
    if [[ ! -f "$NGINX_TEMPLATE" ]]; then
        log_error "Nginx template file not found: $NGINX_TEMPLATE"
        exit 1
    fi
}

# Generate Nginx configuration
generate_config() {
    log_info "Generating Nginx configuration for: $SERVER_NAME"

    # Export SERVER_NAME for envsubst
    export SERVER_NAME

    # Ensure config directory exists
    sudo mkdir -p "$(dirname "$NGINX_CONFIG")"

    # Generate configuration from template
    envsubst '$WEB_DIR $UPLOADS_DIR $SERVER_NAME $API_ADDR $API_PORT $MEMO_URL $BLOG_URL' \
        < "$NGINX_TEMPLATE" | sudo tee "$NGINX_CONFIG" > /dev/null

    log_success "Configuration generated: $NGINX_CONFIG"
}

# Create symlink in sites-enabled
setup_symlink() {
    log_info "Setting up symlink in sites-enabled..."

    # Remove existing symlink if present
    if [[ -L "$NGINX_ENABLED" ]]; then
        log_info "Removing existing symlink..."
        sudo rm "$NGINX_ENABLED"
    fi

    # Create new symlink
    sudo ln -s "$NGINX_CONFIG" "$NGINX_ENABLED"
    log_success "Symlink created: $NGINX_ENABLED"
}

# Remove default Nginx configuration
remove_default_config() {
    local default_config="/etc/nginx/sites-enabled/default"

    if [[ -f "$default_config" ]]; then
        log_info "Removing Nginx default configuration..."
        sudo rm -f "$default_config"
        log_success "Default configuration removed"
    else
        log_info "No default configuration found, skipping removal"
    fi
}

# Test Nginx configuration
test_nginx_config() {
    log_info "Testing Nginx configuration..."

    if sudo nginx -t 2>&1; then
        log_success "Nginx configuration is valid"
        return 0
    else
        log_error "Nginx configuration test failed!"
        return 1
    fi
}

# Reload or start Nginx service
reload_nginx() {
    if sudo systemctl is-active --quiet nginx; then
        log_info "Reloading Nginx..."
        sudo systemctl reload nginx
        log_success "Nginx reloaded successfully"
    else
        log_info "Starting Nginx..."
        sudo systemctl enable nginx
        sudo systemctl start nginx
        log_success "Nginx started successfully"
    fi
}

# Main process
main() {
    log_info "Starting Nginx setup for: $SERVER_NAME"

    # Validate prerequisites
    validate_template

    # Generate and install configuration
    generate_config
    setup_symlink
    remove_default_config

    # Test and apply configuration
    if test_nginx_config; then
        reload_nginx

        # Summary
        log_success "Nginx setup completed successfully!"
        log_info "Configuration file: $NGINX_CONFIG"
        log_info "Symlink: $NGINX_ENABLED"
        log_info "Server name: $SERVER_NAME"
    else
        log_error "Setup failed due to invalid Nginx configuration"
        exit 1
    fi
}

main "$@"
