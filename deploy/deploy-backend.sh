#!/bin/bash
# deploy-backend.sh - Script to deploy backend application
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

# Display usage information
usage() {
    cat <<EOF
Usage: $0 <LANG>

Arguments:
    LANG    Backend language to deploy (required)
                    Supported values: rust|rs, go, python|py, kotlin|kt

Examples:
    $0 rust
    $0 go
    $0 python
    $0 kotlin

Description:
    This script builds and deploys the backend application in the specified language.
    It will:
    - Build the backend from source
    - Deploy compiled/prepared files to deployment directory
    - Configure environment variables
    - Set up and start systemd service
EOF
    exit 1
}

# Parse command line arguments
if [[ $# -ne 1 ]]; then
    usage
fi

BACKEND_LANG="$1"

# Validate backend language
if [[ -z "$BACKEND_LANG" ]]; then
    log_error "Backend language cannot be empty"
    usage
fi

check_not_root

# Define source and destination directories based on language
setup_directories() {
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
            log_info "Supported languages: rust|rs, go, python|py, kotlin|kt"
            exit 1
            ;;
    esac

    # Validate source directory exists
    if [[ ! -d "$SRC_DIR" ]]; then
        log_error "Source directory not found: $SRC_DIR"
        exit 1
    fi
}

# Build backend application
build_backend() {
    log_info "Building $BACKEND_LANG backend..."
    cd "$SRC_DIR"

    case "$BACKEND_LANG" in
        rust|rs)
            # Rust build
            if ! check_command cargo; then
                log_info "Rust not found. Attempting to install Rust..."
                bash "${SCRIPT_DIR}/install-deps.sh" rust
            fi
            source "$HOME/.cargo/env"
            cargo build --release
            BINARY_PATH="target/release/mote"
            ;;

        go)
            # Go build
            if ! check_command go; then
                log_info "Go not found. Attempting to install Go..."
                bash "${SCRIPT_DIR}/install-deps.sh" go
            fi
            export PATH=$PATH:/usr/local/go/bin
            go build -o bin/mote ./cmd/server
            BINARY_PATH="bin/mote"
            ;;

        python|py)
            # Python - verify Python is available
            if ! check_command python3; then
                log_info "Python3 not found. Attempting to install Python3..."
                bash "${SCRIPT_DIR}/install-deps.sh" python
            fi
            log_info "Preparing Python environment..."
            BINARY_PATH=""
            ;;

        kotlin|kt)
            # Kotlin build
            if ! check_command mvn; then
                log_info "Maven not found. Attempting to install Maven..."
                bash "${SCRIPT_DIR}/install-deps.sh" java
            fi
            mvn clean package -DskipTests
            BINARY_PATH="target/mote-*.jar"
            ;;
    esac

    log_success "Build completed successfully"
}

# Stop existing service if running
stop_existing_service() {
    if sudo systemctl is-active --quiet ${APP_NAME}; then
        log_info "Stopping existing service..."
        sudo systemctl stop ${APP_NAME}
        log_success "Service stopped"
    else
        log_info "No existing service running"
    fi
}

# Deploy built files to destination
deploy_files() {
    log_info "Deploying files to: $DEST_DIR"

    # Create destination directory
    sudo mkdir -p "$DEST_DIR"

    case "$BACKEND_LANG" in
        rust|rs|go)
            # Copy binary
            sudo cp "$BINARY_PATH" "$DEST_DIR/"
            sudo chmod +x "$DEST_DIR/mote"
            log_success "Binary deployed"

            # Copy static files if exist
            if [[ -d "static" ]]; then
                log_info "Copying static files..."
                sudo cp -r static "${WEB_DIR}/"
                log_success "Static files copied"
            fi
            ;;

        python|py)
            # Copy all Python files
            log_info "Copying Python application files..."
            sudo cp -r . "$DEST_DIR/"

            # Create Python virtual environment
            log_info "Creating Python virtual environment..."
            sudo -u "$APP_USER" HOME="$DEST_DIR" python3 -m venv "$DEST_DIR/.venv"

            # Install dependencies
            log_info "Installing Python dependencies..."
            sudo -u "$APP_USER" HOME="$DEST_DIR" "$DEST_DIR/.venv/bin/pip" install --upgrade pip
            sudo -u "$APP_USER" HOME="$DEST_DIR" "$DEST_DIR/.venv/bin/pip" install -r "$DEST_DIR/requirements.txt"
            sudo -u "$APP_USER" HOME="$DEST_DIR" "$DEST_DIR/.venv/bin/pip" install gunicorn
            log_success "Python dependencies installed"
            ;;

        kotlin|kt)
            # Copy JAR file
            log_info "Copying JAR file..."
            JAR_FILE=$(ls target/mote-*.jar | head -n 1)
            sudo cp "$JAR_FILE" "$DEST_DIR/mote.jar"

            log_success "Kotlin application deployed"
            ;;
    esac
}

# Set permissions for static files
set_static_permissions() {
    if [[ -d "$WEB_DIR/static" ]]; then
        log_info "Setting permissions for static files..."
        sudo chown -R "$APP_USER:$APP_USER" "$WEB_DIR/static"
        sudo chmod -R 755 "$WEB_DIR/static"
    fi
}

# Generate environment configuration
generate_env_config() {
    log_info "Generating environment configuration file..."

    local base_env="UPLOAD_PATH=${UPLOADS_DIR}
HTTP_PORT=${API_PORT}
HTTP_IP=${API_ADDR}
LOG_LEVEL=${LOG_LEVEL}
LOG_REQUESTS=false"

    # Add language-specific environment variables
    local language_env=""
    case "$BACKEND_LANG" in
        rust|rs)
            language_env="RUST_LOG=info
DATABASE_URL=sqlite://${DB_FILE}"
            ;;
        go)
            language_env="APP_ENV=prod
DATABASE_URL=${DB_FILE}"
            ;;
        python|py)
            language_env="FLASK_ENV=production
DATABASE_URL=sqlite:///${DB_FILE}"
            ;;
        kotlin|kt)
            language_env="SPRING_PROFILES_ACTIVE=prod
DATABASE_URL=sqlite:${DB_FILE}"
            ;;
    esac

    # Write environment file
    sudo tee "${DEST_DIR}/.env" > /dev/null <<EOF
${base_env}

${language_env}
EOF

    sudo chmod 600 "${DEST_DIR}/.env"
    log_success "Environment configuration created"
}

# Set file permissions and ownership
set_permissions() {
    log_info "Setting permissions..."

    ensure_user_exists "$APP_USER"
    sudo chown -R "$APP_USER:$APP_USER" "$DEST_DIR"
    sudo chmod -R 755 "$DEST_DIR"

    if [[ -f "$DEST_DIR/.env" ]]; then
        sudo chmod 600 "$DEST_DIR/.env"
    fi

    log_success "Permissions configured"
}

# Update symlink to current deployment
update_symlink() {
    log_info "Updating current backend symlink..."
    sudo rm -f "$DEPLOY_ROOT/api/current"
    sudo ln -s "$DEST_DIR" "$DEPLOY_ROOT/api/current"
    log_success "Symlink updated"
}

# Main deployment process
main() {
    log_info "Starting $BACKEND_LANG backend deployment..."

    # Setup and validate
    setup_directories

    # Build
    build_backend

    # Deploy
    stop_existing_service
    deploy_files
    set_static_permissions
    generate_env_config
    set_permissions
    update_symlink

    # Generate password file
    bash "${SCRIPT_DIR}/gen-password.sh"

    # Start service
    bash "${SCRIPT_DIR}/setup-systemd.sh" "$BACKEND_LANG"

    # Success summary
    log_success "Successfully deployed $BACKEND_LANG backend!"
}

main "$@"
