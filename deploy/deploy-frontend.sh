#!/bin/bash

# Script to deploy the frontend application

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.env"

check_not_root

FRONTEND_SRC="${PROJECT_ROOT}/frontend"
FRONTEND_DEST="${DEPLOY_ROOT}/web"


cd "$FRONTEND_SRC"

log_info "Installing frontend dependencies..."
npx yarn install --frozen-lockfile --silent

# npm run build
log_info "Building frontend..."
VITE_MEMO_URL=$MEMO_URL VITE_BLOG_URL=$BLOG_URL VITE_MANIFEST_START_URL=$MEMO_URL npx vite build --logLevel error

# Check build output
if [ ! -d "dist" ]; then
    log_error "Build failed: dist directory not found"
    exit 1
fi

# Copy build files
log_info "Copying build files to: $FRONTEND_DEST"
sudo mkdir -p "$FRONTEND_DEST/build"
sudo cp -r dist/* "$FRONTEND_DEST/build/"

# Set permissions
log_info "Setting permissions..."
ensure_user_exists $APP_USER
sudo chown -R "$APP_USER:$APP_USER" "$FRONTEND_DEST"
sudo chmod -R 755 "$FRONTEND_DEST"

# Reload Nginx if configured
if sudo systemctl is-active --quiet nginx && [ -f "/etc/nginx/sites-enabled/${APP_NAME}.conf" ]; then
    log_info "Reloading Nginx configuration..."
    sudo nginx -t && sudo systemctl reload nginx
fi

log_success "Frontend deployed successfully!"
log_info "Frontend files location: $FRONTEND_DEST/build"
