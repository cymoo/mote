#!/bin/bash

# Script to deploy backend application

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.env"

check_not_root

# Get backend language parameter, e.g., rust, go, python, kotlin
BACKEND_LANG="$1"

if [ -z "$BACKEND_LANG" ]; then
    log_error "Please specify backend language: rust, go, python, kotlin"
    exit 1
fi

# Define source and destination directories
case "$BACKEND_LANG" in
    rust|rs)
        SRC_DIR="${PROJECT_ROOT}/api-rs"
        DEST_DIR="${DEPLOY_ROOT}/api/rust"
        ;;
    go)
        SRC_DIR="${PROJECT_ROOT}/api-go"
        DEST_DIR="${DEPLOY_ROOT}/api/go"
        ;;
    python|py)
        SRC_DIR="${PROJECT_ROOT}/api-py"
        DEST_DIR="${DEPLOY_ROOT}/api/python"
        ;;
    kotlin|kt)
        SRC_DIR="${PROJECT_ROOT}/api-kt"
        DEST_DIR="${DEPLOY_ROOT}/api/kotlin"
        ;;
    *)
        log_error "Unsupported language: $BACKEND_LANG"
        exit 1
        ;;
esac

# Build backend
log_info "Building $BACKEND_LANG backend..."
cd "$SRC_DIR"

case "$BACKEND_LANG" in
    rust|rs)
        # Rust build
        if [ ! -f "$HOME/.cargo/env" ]; then
            log_error "Rust is not installed. Please run 'make install' first."
            exit 1
        fi
        source "$HOME/.cargo/env"
        cargo build --release
        BINARY_PATH="target/release/mote"
        ;;

    go)
        # Go build
        if ! check_command go; then
            log_error "Go is not installed. Please run 'make install' first."
            exit 1
        fi
        export PATH=$PATH:/usr/local/go/bin
        go build -o mote ./cmd/server
        BINARY_PATH="mote"
        ;;

    python|py)
        # Python - do nothing special for build
        log_info "Preparing Python environment..."
        BINARY_PATH=""
        ;;

    kotlin|kt)
        # Kotlin build
        if ! check_command mvn; then
            log_error "Maven is not installed. Please run 'make install' first."
            exit 1
        fi
        mvn clean package -DskipTests
        BINARY_PATH="target/mote-*.jar"
        ;;
esac

# Stop existing service
if sudo systemctl is-active --quiet ${APP_NAME}; then
    log_info "Stopping existing service..."
    sudo systemctl stop ${APP_NAME}
fi

# Create destination directory
sudo mkdir -p "$DEST_DIR"

# Copy files to destination
log_info "Copying files to: $DEST_DIR"
case "$BACKEND_LANG" in
    rust|rs|go)
        # Copy binary
        sudo mv "$BINARY_PATH" "$DEST_DIR/"
        sudo chmod +x "$DEST_DIR/mote"

        # Copy static files if exist
        if [ -d "static" ]; then
            # sudo cp -r static "$DEST_DIR/"
            sudo cp -r static "${WEB_DIR}/"
        fi
        ;;

    python|py)
        # Copy all Python files
        sudo cp -r . "$DEST_DIR/"

        # Create Python virtual environment
        log_info "Creating Python virtual environment..."
        sudo -u "$APP_USER" python3 -m venv "$DEST_DIR/.venv"

        # Install dependencies
        log_info "installing Python dependencies..."
        sudo -u "$APP_USER" "$DEST_DIR/.venv/bin/pip" install --upgrade pip
        sudo -u "$APP_USER" "$DEST_DIR/.venv/bin/pip" install -r "$DEST_DIR/requirements.txt"
        sudo -u "$APP_USER" "$DEST_DIR/.venv/bin/pip" install gunicorn
        ;;

    kotlin|kt)
        # Copy JAR file
        JAR_FILE=$(ls target/mote-*.jar | head -n 1)
        sudo mv "$JAR_FILE" "$DEST_DIR/mote.jar"

        # TODO: 需要复制资源文件吗？
        if [ -d "src/main/resources" ]; then
            sudo cp -r src/main/resources "$DEST_DIR/"
        fi
        ;;
esac

# If static directory exists, set permissions
if [ -d "$FRONTEND_DEST/static" ]; then
    sudo chown -R "$APP_USER:$APP_USER" "$FRONTEND_DEST/static"
    sudo chmod -R 755 "$FRONTEND_DEST/static"
fi

log_info "Generating environment configuration file..."

BASE_ENV_TEMPLATE="""
UPLOAD_PATH=${UPLOADS_DIR}
HTTP_PORT=${API_PORT}
HTTP_IP=${API_ADDR}
LOG_REQUESTS=false
"""

# Add language-specific environment variables
case "$BACKEND_LANG" in
    rust|rs)
        LANGUAGE_SPECIFIC="""
RUST_LOG=info
DATABASE_URL=sqlite://${DB_PATH}
"""
        ;;
    go)
        LANGUAGE_SPECIFIC="""
APP_ENV=prod
DATABASE_URL=${DB_PATH}
"""
        ;;
    python|py)
        LANGUAGE_SPECIFIC="""
FLASK_ENV=production
DATABASE_URL=sqlite:///${DB_PATH}
"
        ;;
    kotlin|kt)
        LANGUAGE_SPECIFIC="""
SPRING_PROFILES_ACTIVE=prod
DATABASE_URL=sqlite:${DB_PATH}
"""
        ;;
esac

# Combine and generate environment configuration file
ENV_CONTENT="$BASE_ENV_TEMPLATE
$LANGUAGE_SPECIFIC"

# Ensure destination directory exists
sudo mkdir -p "$DEST_DIR"

# Write environment file
sudo tee "${DEST_DIR}/.env" > /dev/null <<EOF
$ENV_CONTENT
EOF

log_info "Setting permissions..."
ensure_user_exists $APP_USER
sudo chown -R "$APP_USER:$APP_USER" "$DEST_DIR"
sudo chmod -R 755 "$DEST_DIR"
[ -f "$DEST_DIR/.env" ] && sudo chmod 600 "$DEST_DIR/.env"

# Update current symlink
log_info "Updating current backend symlink..."
sudo rm -f "$DEPLOY_ROOT/api/current"
sudo ln -s "$DEST_DIR" "$DEPLOY_ROOT/api/current"

# Configure systemd service
log_info "Configuring systemd service..."
bash "${SCRIPT_DIR}/setup-systemd.sh" "$BACKEND_LANG"

# Wait for a few seconds to let the service start
sleep 2

# Check service status
if sudo systemctl is-active --quiet ${APP_NAME}; then
    log_success "$BACKEND_LANG backend deployed successfully!"
    log_info "Service status:"
    sudo systemctl status ${APP_NAME} --no-pager | head -n 10
else
    log_error "Failed to start service!"
    sudo systemctl status ${APP_NAME} --no-pager
    exit 1
fi

log_success "Deployed $BACKEND_LANG backend successfully!"
