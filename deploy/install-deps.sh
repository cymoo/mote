#!/bin/bash
# Script to install system dependencies
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

# Display usage information
usage() {
    cat <<EOF
Usage: $0 <COMPONENT> [COMPONENT...] [OPTIONS]

Components (at least one required):
    sys, system         System dependencies (curl, wget, git, nginx, sqlite3, etc.)
    node, nodejs        Node.js and npm
    rust                Rust toolchain
    go, golang          Go language
    python, py          Python3 and pip
    jdk, java           Java and Maven
    redis               Redis server

Options:
    -h, --help          Show this help message
    --china-mirror      Use China mirrors for faster downloads

Examples:
    $0 sys                      # Install only system dependencies
    $0 python                   # Install only Python
    $0 python rust              # Install Python and Rust
    $0 node go redis            # Install Node.js, Go, and Redis
    $0 sys python --china-mirror   # Install with China mirrors

Description:
    This script installs development dependencies for the project.
    You must specify at least one component to install.

    Each component is installed independently - no automatic dependencies.
EOF
    exit 0
}

# Parse command line arguments
declare -a COMPONENTS_TO_INSTALL
CHINA_MIRROR=false

if [[ $# -eq 0 ]]; then
    log_error "No components specified"
    echo ""
    usage
fi

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
            COMPONENTS_TO_INSTALL+=("system")
            shift
            ;;
        node|nodejs)
            COMPONENTS_TO_INSTALL+=("nodejs")
            shift
            ;;
        rust)
            COMPONENTS_TO_INSTALL+=("rust")
            shift
            ;;
        go|golang)
            COMPONENTS_TO_INSTALL+=("go")
            shift
            ;;
        python|py)
            COMPONENTS_TO_INSTALL+=("python")
            shift
            ;;
        jdk|java)
            COMPONENTS_TO_INSTALL+=("jdk")
            shift
            ;;
        redis)
            COMPONENTS_TO_INSTALL+=("redis")
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

# Validate at least one component
if [[ ${#COMPONENTS_TO_INSTALL[@]} -eq 0 ]]; then
    log_error "No components specified"
    echo ""
    usage
fi

# Install system dependencies
install_system_deps() {
    log_info "Installing system dependencies..."

    sudo apt-get update -qq
    sudo apt-get install -y -qq \
        curl \
        wget \
        git \
        build-essential \
        pkg-config \
        gpg \
        openssl \
        libssl-dev \
        ca-certificates \
        gnupg \
        lsb-release \
        gettext-base \
        nginx \
        sqlite3 \
        libsqlite3-dev \
        > /dev/null

    sudo systemctl enable nginx
    sudo systemctl start nginx

    log_success "System dependencies installed"
}

# Install Node.js
install_nodejs() {
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
    sudo ln -sf "/usr/local/node-${NODE_VERSION}-linux-x64" /usr/local/node

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

    # Create symlinks
    sudo ln -sf /usr/local/go/bin/go /usr/bin/go
    sudo ln -sf /usr/local/go/bin/gofmt /usr/bin/gofmt

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

    log_success "Python $(python3 --version | awk '{print $2}') installed"
}

# Install Java and Maven
install_jdk() {
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

# Install Redis
install_redis() {
    # Check if already installed
    if command -v redis-server &> /dev/null; then
        local redis_version=$(redis-server --version | awk '{print $3}' | cut -d'=' -f2)
        log_info "Redis $redis_version already installed"
        return 0
    fi

    log_info "Installing Redis..."

    # Add Redis repository
    curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
    sudo chmod 644 /usr/share/keyrings/redis-archive-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" | \
        sudo tee /etc/apt/sources.list.d/redis.list > /dev/null

    # Install Redis
    sudo apt-get update -qq
    sudo apt-get install -y -qq redis > /dev/null

    # Enable and start Redis
    sudo systemctl enable redis-server
    sudo systemctl start redis-server

    log_success "Redis $(redis-server --version | awk '{print $3}' | cut -d'=' -f2) installed"
}

# Verify a single component installation
verify_component() {
    local component="$1"

    case "$component" in
        system)
            local verified=true
            for cmd in curl wget git nginx sqlite3; do
                if ! command -v "$cmd" &> /dev/null; then
                    echo "  ✗ $cmd (missing)"
                    verified=false
                fi
            done
            if [[ "$verified" == true ]]; then
                echo "  ✓ System dependencies"
            fi
            ;;
        nodejs)
            if command -v node &> /dev/null; then
                echo "  ✓ node ($(node --version))"
            else
                echo "  ✗ node (missing)"
                return 1
            fi
            ;;
        rust)
            if [[ -f "$HOME/.cargo/bin/rustc" ]]; then
                echo "  ✓ rust ($("$HOME/.cargo/bin/rustc" --version | awk '{print $2}'))"
            else
                echo "  ✗ rust (missing)"
                return 1
            fi
            ;;
        go)
            if command -v go &> /dev/null; then
                echo "  ✓ go ($(go version | awk '{print $3}'))"
            else
                echo "  ✗ go (missing)"
                return 1
            fi
            ;;
        python)
            if command -v python3 &> /dev/null; then
                echo "  ✓ python3 ($(python3 --version | awk '{print $2}'))"
            else
                echo "  ✗ python3 (missing)"
                return 1
            fi
            ;;
        jdk)
            if command -v java &> /dev/null; then
                echo "  ✓ java ($(java -version 2>&1 | head -n 1 | awk -F '"' '{print $2}'))"
            else
                echo "  ✗ java (missing)"
                return 1
            fi
            ;;
        redis)
            if command -v redis-server &> /dev/null; then
                echo "  ✓ redis ($(redis-server --version | awk '{print $3}' | cut -d'=' -f2))"
            else
                echo "  ✗ redis (missing)"
                return 1
            fi
            ;;
    esac

    return 0
}

# Verify all installed components
verify_installations() {
    log_info "Verifying installations..."
    echo ""

    local all_ok=true

    for component in "${COMPONENTS_TO_INSTALL[@]}"; do
        if ! verify_component "$component"; then
            all_ok=false
        fi
    done

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

    for component in "${COMPONENTS_TO_INSTALL[@]}"; do
        if [[ "$component" == "rust" ]] || [[ "$component" == "go" ]]; then
            needs_notes=true
            break
        fi
    done

    if [[ "$needs_notes" == false ]]; then
        return 0
    fi

    echo ""
    log_info "Post-installation notes:"
    echo ""

    for component in "${COMPONENTS_TO_INSTALL[@]}"; do
        case "$component" in
            rust)
                echo "  Rust: Run 'source \$HOME/.cargo/env' to use Rust in current shell"
                ;;
            go)
                echo "  Go: Run 'source /etc/profile' or logout/login to update PATH"
                ;;
        esac
    done

    echo ""
    log_info "You may need to restart your shell or logout/login for all changes to take effect."
}

# Print installation summary
print_summary() {
    echo ""
    log_info "Components to install:"
    echo ""

    for component in "${COMPONENTS_TO_INSTALL[@]}"; do
        case "$component" in
            system) echo "  • System dependencies" ;;
            nodejs) echo "  • Node.js" ;;
            rust) echo "  • Rust" ;;
            go) echo "  • Go" ;;
            python) echo "  • Python" ;;
            jdk) echo "  • Java/Maven" ;;
            redis) echo "  • Redis" ;;
        esac
    done
}

# Main installation process
main() {
    log_info "Starting dependency installation..."

    # Show what will be installed
    print_summary
    echo ""

    # Install each component
    for component in "${COMPONENTS_TO_INSTALL[@]}"; do
        case "$component" in
            system) install_system_deps ;;
            nodejs) install_nodejs ;;
            rust) install_rust ;;
            go) install_go ;;
            python) install_python ;;
            jdk) install_jdk ;;
            redis) install_redis ;;
        esac
    done

    # Verify
    verify_installations

    # Notes
    print_notes

    echo ""
    log_success "Installation completed successfully!"
}

main "$@"
