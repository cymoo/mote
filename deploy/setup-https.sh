#!/bin/bash
# setup-https.sh - Script to setup HTTPS using Let's Encrypt SSL certificates
set -eo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
source "${SCRIPT_DIR}/common.sh"

WEBROOT_PATH="/var/www/certbot"

# Display usage information
usage() {
    cat <<EOF
Usage: $0 <DOMAIN> [EMAIL]

Arguments:
    DOMAIN    Domain name for the SSL certificate (required)
    EMAIL     Email address for certificate notifications (optional)

Examples:
    $0 example.com admin@example.com
    $0 example.com

Note: If EMAIL is not provided, the certificate will be registered without email notifications.
EOF
    exit 1
}

# Parse command line arguments
if [[ $# -lt 1 || $# -gt 2 ]]; then
    usage
fi

DOMAIN="$1"
EMAIL="${2:-}"

# Validate DOMAIN
if [[ -z "$DOMAIN" ]]; then
    echo "Error: DOMAIN cannot be empty" >&2
    usage
fi

# Ensure webroot directory exists
ensure_webroot() {
    log_info "Ensuring webroot directory exists..."
    sudo mkdir -p "$WEBROOT_PATH"
    sudo chmod -R 755 "$WEBROOT_PATH"
    log_info "Webroot directory ready: $WEBROOT_PATH"
}

# Install dependencies
install_dependencies() {
    log_info "Installing system dependencies..."
    sudo apt-get update -q
    sudo apt-get install -q -y nginx certbot python3-certbot-nginx openssl > /dev/null || {
        log_error "Failed to install dependencies" >&2
        exit 1
    }
}

# Generate DH parameters
generate_dhparam() {
    local dh_file="/etc/nginx/ssl/dhparam.pem"
    sudo mkdir -p /etc/nginx/ssl
    if [[ ! -f "$dh_file" ]]; then
        log_info "Generating Diffie-Hellman parameters (this may take 1-3 minutes)..."
        sudo openssl dhparam -out "$dh_file" 2048
        sudo chmod 600 "$dh_file"
        log_info "DH parameters generated: $dh_file"
    else
        log_info "Existing DH parameter file detected, skipping generation"
    fi
}

# Setup temporary Nginx config for certificate validation
setup_temp_nginx_config() {
    log_info "Setting up temporary Nginx configuration..."

    # Create temporary Nginx config
    sudo tee /etc/nginx/conf.d/"${DOMAIN}"-temp.conf > /dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root $WEBROOT_PATH;
    }

    location / {
        return 444;
    }
}
EOF

    # Test and reload Nginx
    if sudo nginx -t 2>/dev/null; then
        sudo systemctl reload nginx
        log_info "Temporary Nginx configuration loaded"
    else
        log_error "Nginx configuration test failed"
        exit 1
    fi
}

# Remove temporary Nginx config
cleanup_temp_config() {
    log_info "Removing temporary Nginx configuration..."
    sudo rm -f /etc/nginx/conf.d/"${DOMAIN}"-temp.conf
    sudo nginx -t 2>/dev/null && sudo systemctl reload nginx
}

# Request SSL certificate
request_certificate() {
    log_info "Requesting SSL certificate for ${DOMAIN} using webroot mode..."

    # Build certbot command
    local certbot_cmd=(
        sudo certbot certonly --webroot
        -w "$WEBROOT_PATH"
        -d "$DOMAIN"
        --agree-tos
        --non-interactive
        --keep-until-expiring
    )

    # Add email or register without email
    if [[ -n "$EMAIL" ]]; then
        certbot_cmd+=(--email "$EMAIL")
        log_info "Using email: $EMAIL"
    else
        certbot_cmd+=(--register-unsafely-without-email)
        log_info "Registering without email (no expiration notifications will be sent)"
    fi

    # Execute certbot
    if "${certbot_cmd[@]}"; then
        log_success "SSL certificate obtained successfully"
        return 0
    else
        log_error "Failed to obtain SSL certificate"
        return 1
    fi
}

# Main process
main() {
    log_info "Starting SSL certificate setup for: $DOMAIN"

    ensure_webroot
    install_dependencies
    generate_dhparam
    setup_temp_nginx_config

    # Request certificate
    if request_certificate; then
        cleanup_temp_config
        log_info "Certificate location: /etc/letsencrypt/live/${DOMAIN}/"
        log_success "Certificate setup completed successfully!"
    else
        cleanup_temp_config
        exit 1
    fi
}

main "$@"
