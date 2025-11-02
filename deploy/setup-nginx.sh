#!/bin/bash

# Script to setup Nginx configuration

set -eo pipefail

# SERVER_NAME="${SERVER_NAME:?The SERVER_NAME environment variable must be set}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.env"

export SERVER_NAME="$1"

if [ -z "$SERVER_NAME" ]; then
    log_error "Usage: bash setup-nginx.sh <your.domain.com>"
    exit 1
fi

NGINX_TEMPLATE="${SCRIPT_DIR}/nginx.template"

NGINX_CONFIG="${CONFIG_DIR}/nginx/${APP_NAME}.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/${APP_NAME}.conf"

# Generate Nginx configuration
log_info "Generating Nginx configuration..."

envsubst '$WEB_DIR $UPLOADS_DIR $SERVER_NAME $API_ADDR $API_PORT $MEMO_URL $BLOG_URL' < "$NGINX_TEMPLATE" | sudo tee "$NGINX_CONFIG" > /dev/null


# Create symlink in sites-enabled
if [ -L "$NGINX_ENABLED" ]; then
    sudo rm "$NGINX_ENABLED"
fi
sudo ln -s "$NGINX_CONFIG" "$NGINX_ENABLED"

# Delete default Nginx config
if [ -f "/etc/nginx/sites-enabled/default" ]; then
    log_info "移除Nginx默认配置..."
    sudo rm -f /etc/nginx/sites-enabled/default
fi

# Test Nginx configuration
log_info "Testing Nginx configuration..."
if sudo nginx -t; then
    log_success "Nginx configuration is valid"

    # Reload Nginx
    if sudo systemctl is-active --quiet nginx; then
        log_info "Reloading Nginx..."
        sudo systemctl reload nginx
    else
        log_info "Starting Nginx..."
        sudo systemctl enable nginx
        sudo systemctl start nginx
    fi
else
    log_error "Nginx configuration test failed!"
    exit 1
fi

log_success "Nginx setup completed successfully!"
log_info "Configuration file: $NGINX_CONFIG"
log_info "Symlink: $NGINX_ENABLED"
