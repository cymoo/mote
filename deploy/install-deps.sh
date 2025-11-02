#!/bin/bash
# Script to install system dependencies
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.env"

# Display usage information
usage() {
    cat <<EOF
Usage: $0 [COMPONENTS...] [OPTIONS]

Components:
    sys, system         System dependencies (curl, wget, git, nginx, sqlite3, etc.)
    node, nodejs        Node.js and npm
    rust                Rust toolchain
    go, golang          Go language
    python, py          Python3 and pip
    kotlin, kt, java    Java/Kotlin and Maven
    all                 Install all components (default if no components specified)

Options:
    -h, --help          Show this help message
    --china-mirror      Use China mirrors for faster downloads

Examples:
    $0                      # Install all components
    $0 sys                  # Install only system dependencies
    $0 python               # Install system deps + Python
    $0 python rust          # Install system deps + Python + Rust
    $0 node go --china-mirror   # Install Node.js and Go with China mirrors
    $0 all --china-mirror   # Install everything with China mirrors

Description:
    This script installs development dependencies for the project.
    System dependencies are always installed first as they are required.

    If no components are specified, all components will be installed.
EOF
    exit 0
}

# Parse command line arguments
INSTALL_SYSTEM=false
INSTALL_NODEJS=false
INSTALL_RUST=false
INSTALL_GO=false
INSTALL_PYTHON=false
INSTALL_KOTLIN=false
CHINA_MIRROR=false
INSTALL_ALL=true

# Check if any components are specified
has_components=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            ;;
        --china-mirror)
            CHINA_MIRROR=true
            shift
            ;;
        sys|system)
            INSTALL_SYSTEM=true
            INSTALL_ALL=false
            has_components=true
            shift
            ;;
        node|nodejs)
            INSTALL_NODEJS=true
            INSTALL_ALL=false
            has_components=true
            shift
            ;;
        rust)
            INSTALL_RUST=true
            INSTALL_ALL=false
            has_components=true
            shift
            ;;
        go|golang)
            INSTALL_GO=true
            INSTALL_ALL=false
            has_components=true
            shift
            ;;
        python|py)
            INSTALL_PYTHON=true
            INSTALL_ALL=false
            has_components=true
            shift
            ;;
        kotlin|kt|java)
            INSTALL_KOTLIN=true
            INSTALL_ALL=false
            has_components=true
            shift
            ;;
        all)
            INSTALL_ALL=true
            shift
            ;;
        *)
            log_error "Unknown component: $1"
            echo ""
            log_info "Run '$0 --help' for usage information"
            exit 1
            ;;
    esac
done

# If installing all or any language component, include system deps
if [[ "$INSTALL_ALL" == true ]] || [[ "$has_components" == true ]]; then
    INSTALL_SYSTEM=true
fi

# If installing all, enable everything
if [[ "$INSTALL_ALL" == true ]]; then
    INSTALL_NODEJS=true
    INSTALL_RUST=true
    INSTALL_GO=true
    INSTALL_PYTHON=true
    INSTALL_KOTLIN=true
fi

# Install system dependencies (nginx, sqlite3, build tools, etc.)
install_system_deps() {
    if [[ "$INSTALL_SYSTEM" == false ]]; then
        return 0
    fi

    log_info "Installing system dependencies..."

    sudo apt-get update -qq
    sudo apt-get install -y -qq \
        curl \
        wget \
        git \
        build-essential \
        pkg-config \
        libssl-dev \
        ca-certificates \
        gnupg \
        lsb-release \
        gettext-base \
        nginx \
        sqlite3 \
        libsqlite3-dev \
        > /dev/null

    # Enable Nginx but don't start it yet
    sudo systemctl enable nginx

    log_success "System dependencies installed"
}

# Install Node.js
install_nodejs() {
    if [[ "$INSTALL_NODEJS" == false ]]; then
        return 0
    fi

    # Check if already installed with correct version
    if command -v node &> /dev/null; then
        local installed_version=$(node --version)
        if [[ "$installed_version" == "$NODE_VERSION" ]]; then
            log_info "Node.js $installed_version already installed"
            return 0
        fi
    fi

    log_info "Installing Node.js ${NODE_VERSION}..."

    # Determine download URL
    if [[ "$CHINA_MIRROR" == true ]]; then
        local download_url="https://npmmirror.com/mirrors/node/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz"
    else
        local download_url="https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz"
    fi

    # Download and extract
    wget -q --show-progress "$download_url" -O /tmp/node.tar.xz
    sudo tar -xJf /tmp/node.tar.xz -C /usr/local/
    sudo rm -f /usr/local/node
    sudo ln -sf "/usr/local/node-${NODE_VERSION}-linux-x64 /usr/local/node"

    # Create symlinks
    sudo ln -sf /usr/local/node/bin/node /usr/bin/node
    sudo ln -sf /usr/local/node/bin/npm /usr/bin/npm
    sudo ln -sf /usr/local/node/bin/npx /usr/bin/npx

    # Configure npm registry
    if [[ "$CHINA_MIRROR" == true ]]; then
        npm config set registry https://registry.npmmirror.com
        log_info "Configured npm to use China mirror"
    fi

    # Clean up
    rm -f /tmp/node.tar.xz

    log_success "Node.js $(node --version) installed"
}

# Install Rust
install_rust() {
    if [[ "$INSTALL_RUST" == false ]]; then
        return 0
    fi

    # Check if already installed
    if [[ -f "$HOME/.cargo/bin/rustc" ]]; then
        local rust_version=$("$HOME/.cargo/bin/rustc" --version | awk '{print $2}')
        log_info "Rust $rust_version already installed"
        return 0
    fi

    log_info "Installing Rust toolchain..."

    # Configure mirror if needed
    if [[ "$CHINA_MIRROR" == true ]]; then
        export RUSTUP_DIST_SERVER="https://rsproxy.cn"
        export RUSTUP_UPDATE_ROOT="https://rsproxy.cn/rustup"
    fi

    # Install Rust
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable

    # Source cargo env
    source "$HOME/.cargo/env"

    # Configure cargo mirror
    mkdir -p "$HOME/.cargo"

    if [[ "$CHINA_MIRROR" == true ]]; then
        cat > "$HOME/.cargo/config.toml" <<'EOF'
[source.crates-io]
replace-with = 'rsproxy-sparse'

[source.rsproxy]
registry = "https://rsproxy.cn/crates.io-index"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[registries.rsproxy]
index = "https://rsproxy.cn/crates.io-index"

[net]
git-fetch-with-cli = true
EOF
        log_info "Configured Cargo to use China mirror"
    fi

    log_success "Rust $(rustc --version | awk '{print $2}') installed"
}

# Install Go
install_go() {
    if [[ "$INSTALL_GO" == false ]]; then
        return 0
    fi

    # Check if already installed with correct version
    if [[ -f /usr/local/go/bin/go ]]; then
        local installed_version=$(/usr/local/go/bin/go version | awk '{print $3}' | sed 's/go//')
        if [[ "$installed_version" == "$GOLANG_VERSION" ]]; then
            log_info "Go $installed_version already installed"
            return 0
        fi
    fi

    log_info "Installing Go ${GOLANG_VERSION}..."

    # Determine download URL
    if [[ "$CHINA_MIRROR" == true ]]; then
        local download_url="https://golang.google.cn/dl/go${GOLANG_VERSION}.linux-amd64.tar.gz"
    else
        local download_url="https://go.dev/dl/go${GOLANG_VERSION}.linux-amd64.tar.gz"
    fi

    # Download and install
    wget -q --show-progress "$download_url" -O /tmp/go.tar.gz
    sudo rm -rf /usr/local/go
    sudo tar -C /usr/local -xzf /tmp/go.tar.gz

    # Add to PATH (for current session)
    export PATH=$PATH:/usr/local/go/bin

    # Add to profile if not already there
    if ! grep -q "/usr/local/go/bin" /etc/profile; then
        echo 'export PATH=$PATH:/usr/local/go/bin' | sudo tee -a /etc/profile > /dev/null
    fi

    # Configure GOPROXY for China
    if [[ "$CHINA_MIRROR" == true ]]; then
        /usr/local/go/bin/go env -w GO111MODULE=on
        /usr/local/go/bin/go env -w GOPROXY=https://goproxy.cn,direct
        log_info "Configured Go to use China proxy"
    fi

    # Clean up
    rm -f /tmp/go.tar.gz

    log_success "Go $(/usr/local/go/bin/go version | awk '{print $3}') installed"
}

# Install Python
install_python() {
    if [[ "$INSTALL_PYTHON" == false ]]; then
        return 0
    fi

    log_info "Installing Python3 and pip..."

    sudo apt-get install -y -qq \
        python3 \
        python3-pip \
        python3-venv \
        python3-dev \
        > /dev/null

    # Configure pip mirror
    if [[ "$CHINA_MIRROR" == true ]]; then
        mkdir -p "$HOME/.pip"
        cat > "$HOME/.pip/pip.conf" <<EOF
[global]
index-url = https://pypi.tuna.tsinghua.edu.cn/simple
[install]
trusted-host = pypi.tuna.tsinghua.edu.cn
EOF
        log_info "Configured pip to use China mirror"
    fi

    # Upgrade pip
    python3 -m pip install --upgrade pip -q

    log_success "Python $(python3 --version | awk '{print $2}') installed"
}

# Install Java and Kotlin
install_kotlin() {
    if [[ "$INSTALL_KOTLIN" == false ]]; then
        return 0
    fi

    log_info "Installing Java and Maven..."

    # Install OpenJDK and Maven
    sudo apt-get install -y -qq openjdk-21-jdk maven > /dev/null

    # Configure Maven mirror for China
    if [[ "$CHINA_MIRROR" == true ]]; then
        local maven_settings="$HOME/.m2/settings.xml"
        mkdir -p "$HOME/.m2"

        cat > "$maven_settings" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.0.0
                              http://maven.apache.org/xsd/settings-1.0.0.xsd">
    <mirrors>
        <mirror>
            <id>aliyun-maven</id>
            <mirrorOf>central</mirrorOf>
            <name>Aliyun Maven</name>
            <url>https://maven.aliyun.com/repository/public</url>
        </mirror>
    </mirrors>
</settings>
EOF
        log_info "Configured Maven to use China mirror"
    fi

    log_success "Java $(java -version 2>&1 | head -n 1 | awk -F '"' '{print $2}') installed"
}

# Verify installations
verify_installations() {
    log_info "Verifying installations..."
    echo ""

    local all_ok=true

    # Check system tools
    if [[ "$INSTALL_SYSTEM" == true ]]; then
        for cmd in curl wget git nginx sqlite3; do
            if command -v "$cmd" &> /dev/null; then
                echo "  ✓ $cmd"
            else
                echo "  ✗ $cmd (missing)"
                all_ok=false
            fi
        done
    fi

    # Check Node.js
    if [[ "$INSTALL_NODEJS" == true ]]; then
        if command -v node &> /dev/null; then
            echo "  ✓ node ($(node --version))"
        else
            echo "  ✗ node (missing)"
            all_ok=false
        fi
    fi

    # Check Rust
    if [[ "$INSTALL_RUST" == true ]]; then
        if [[ -f "$HOME/.cargo/bin/rustc" ]]; then
            echo "  ✓ rust ($("$HOME/.cargo/bin/rustc" --version | awk '{print $2}'))"
        else
            echo "  ✗ rust (missing)"
            all_ok=false
        fi
    fi

    # Check Go
    if [[ "$INSTALL_GO" == true ]]; then
        if command -v go &> /dev/null; then
            echo "  ✓ go ($(go version | awk '{print $3}'))"
        else
            echo "  ✗ go (missing)"
            all_ok=false
        fi
    fi

    # Check Python
    if [[ "$INSTALL_PYTHON" == true ]]; then
        if command -v python3 &> /dev/null; then
            echo "  ✓ python3 ($(python3 --version | awk '{print $2}'))"
        else
            echo "  ✗ python3 (missing)"
            all_ok=false
        fi
    fi

    # Check Java
    if [[ "$INSTALL_KOTLIN" == true ]]; then
        if command -v java &> /dev/null; then
            echo "  ✓ java ($(java -version 2>&1 | head -n 1 | awk -F '"' '{print $2}'))"
        else
            echo "  ✗ java (missing)"
            all_ok=false
        fi
    fi

    echo ""

    if [[ "$all_ok" == true ]]; then
        log_success "All installations verified successfully!"
    else
        log_error "Some installations failed. Please check the output above."
        return 1
    fi
}

# Print post-installation notes
print_notes() {
    local needs_notes=false

    if [[ "$INSTALL_RUST" == true ]] || [[ "$INSTALL_GO" == true ]]; then
        needs_notes=true
    fi

    if [[ "$needs_notes" == false ]]; then
        return 0
    fi

    echo ""
    log_info "Post-installation notes:"
    echo ""

    if [[ "$INSTALL_RUST" == true ]]; then
        echo "  Rust: Run 'source \$HOME/.cargo/env' to use Rust in current shell"
    fi

    if [[ "$INSTALL_GO" == true ]]; then
        echo "  Go: Run 'source /etc/profile' or logout/login to update PATH"
    fi

    echo ""
    log_info "You may need to restart your shell or logout/login for all changes to take effect."
}

# Print installation summary
print_summary() {
    echo ""
    log_info "Installation summary:"
    echo ""

    local installed=()

    [[ "$INSTALL_SYSTEM" == true ]] && installed+=("System dependencies")
    [[ "$INSTALL_NODEJS" == true ]] && installed+=("Node.js")
    [[ "$INSTALL_RUST" == true ]] && installed+=("Rust")
    [[ "$INSTALL_GO" == true ]] && installed+=("Go")
    [[ "$INSTALL_PYTHON" == true ]] && installed+=("Python")
    [[ "$INSTALL_KOTLIN" == true ]] && installed+=("Java/Kotlin")

    for component in "${installed[@]}"; do
        echo "  • $component"
    done
}

# Main installation process
main() {
    log_info "Starting dependency installation..."

    # Show what will be installed
    print_summary
    echo ""

    # Install components
    install_system_deps
    install_nodejs
    install_rust
    install_go
    install_python
    install_kotlin

    # Verify
    verify_installations

    # Notes
    print_notes

    echo ""
    log_success "Installation completed successfully!"
}

main "$@"
