#!/bin/bash
# Health check script for application deployment
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

# Display usage information
usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Options:
    -h, --help          Show this help message
    -v, --verbose       Show detailed output
    --skip-http         Skip HTTP health checks
    --skip-system       Skip system resource checks

Examples:
    $0
    $0 --verbose
    $0 --skip-http

Description:
    Performs comprehensive health checks on the deployed application:
    - Deployment directories
    - Nginx service and configuration
    - Backend service
    - Port listeners
    - Database accessibility
    - Upload directory permissions
    - Frontend files
    - HTTP endpoints
    - System resources (disk, memory)
EOF
    exit 0
}

# Parse command line options
VERBOSE=false
SKIP_HTTP=false
SKIP_SYSTEM=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        --skip-http)
            SKIP_HTTP=true
            shift
            ;;
        --skip-system)
            SKIP_SYSTEM=true
            shift
            ;;
        *)
            log_error "Unknown option: $1"
            usage
            ;;
    esac
done

check_not_root

HEALTH_STATUS=0

# Track check results
declare -a FAILED_CHECKS
declare -a WARNING_CHECKS
declare -a PASSED_CHECKS

# Helper function to record check result
record_check() {
    local status="$1"
    local message="$2"

    case "$status" in
        pass)
            PASSED_CHECKS+=("$message")
            ;;
        warn)
            WARNING_CHECKS+=("$message")
            ;;
        fail)
            FAILED_CHECKS+=("$message")
            HEALTH_STATUS=1
            ;;
    esac
}

# Check deployment directory
check_deployment_directory() {
    log_info "Checking deployment directory..."

    if [[ -d "$DEPLOY_ROOT" ]]; then
        log_success "Deployment directory exists: $DEPLOY_ROOT"
        record_check "pass" "Deployment directory"
    else
        log_error "Deployment directory not found: $DEPLOY_ROOT"
        record_check "fail" "Deployment directory"
    fi
}

# Check Nginx service
check_nginx() {
    log_info "Checking Nginx..."

    if sudo systemctl is-active --quiet nginx; then
        log_success "Nginx is running"
        record_check "pass" "Nginx service"

        # Test Nginx configuration
        if sudo nginx -t 2>&1 | grep -q "successful"; then
            log_success "Nginx configuration is valid"
            record_check "pass" "Nginx configuration"
        else
            log_error "Nginx configuration is invalid"
            record_check "fail" "Nginx configuration"
        fi
    else
        log_error "Nginx is not running"
        record_check "fail" "Nginx service"
    fi
}

# Check backend service
check_backend_service() {
    log_info "Checking backend service..."

    if sudo systemctl is-active --quiet "${APP_NAME}"; then
        log_success "Backend service is running"
        record_check "pass" "Backend service"

        # Check current backend symlink
        if [[ -L "$DEPLOY_ROOT/api/current" ]]; then
            local current_backend=$(basename "$(readlink "$DEPLOY_ROOT/api/current")")
            log_info "Current backend: $current_backend"
            record_check "pass" "Backend symlink"
        else
            log_warn "Current backend symlink not set"
            record_check "warn" "Backend symlink"
        fi

        # Show recent logs if verbose
        if [[ "$VERBOSE" == true ]]; then
            log_info "Recent backend logs:"
            sudo journalctl -u "${APP_NAME}" -n 5 --no-pager
        fi
    else
        log_error "Backend service is not running"
        record_check "fail" "Backend service"
    fi
}

# Check port listeners
check_ports() {
    log_info "Checking port listeners..."

    # Check if netstat or ss is available
    if command -v ss &> /dev/null; then
        local port_cmd="ss -tlnp"
    elif command -v netstat &> /dev/null; then
        local port_cmd="netstat -tlnp"
    else
        log_warn "Neither ss nor netstat available, skipping port check"
        record_check "warn" "Port check (command not found)"
        return
    fi

    # Check backend port
    if sudo $port_cmd 2>/dev/null | grep -q ":${API_PORT}"; then
        log_success "Backend port ${API_PORT} is listening"
        record_check "pass" "Backend port"
    else
        log_error "Backend port ${API_PORT} is not listening"
        record_check "fail" "Backend port"
    fi

    # Check HTTP port
    if sudo $port_cmd 2>/dev/null | grep -q ":80"; then
        log_success "HTTP port 80 is listening"
        record_check "pass" "HTTP port"
    else
        log_error "HTTP port 80 is not listening"
        record_check "fail" "HTTP port"
    fi
}

# Check database
check_database() {
    log_info "Checking database..."

    # Use sudo to check if file exists (works regardless of permissions)
    if sudo test -f "$DB_FILE"; then
        log_success "Database exists: $DB_FILE"
        record_check "pass" "Database file"

        # Check database permissions as app user
        if sudo -u "$APP_USER" test -r "$DB_FILE"; then
            log_success "Database is readable by $APP_USER"
            record_check "pass" "Database permissions"
        else
            log_error "Database is not readable by $APP_USER"
            record_check "fail" "Database permissions"
        fi

        # Check database size if verbose
        if [[ "$VERBOSE" == true ]]; then
            local db_size=$(sudo du -h "$DB_FILE" | cut -f1)
            log_info "Database size: $db_size"
        fi
    else
        log_warn "Database file not found: $DB_FILE (normal for first deployment)"
        record_check "warn" "Database file (not created yet)"
    fi
}

# Check upload directory
check_upload_directory() {
    log_info "Checking upload directory..."

    if [[ -d "$UPLOADS_DIR" ]]; then
        log_success "Upload directory exists: $UPLOADS_DIR"
        record_check "pass" "Upload directory"

        if sudo -u "$APP_USER" test -w "$UPLOADS_DIR"; then
            log_success "Upload directory is writable by $APP_USER"
            record_check "pass" "Upload directory permissions"
        else
            log_error "Upload directory is not writable by $APP_USER"
            record_check "fail" "Upload directory permissions"
        fi

        # Show upload count if verbose
        if [[ "$VERBOSE" == true ]]; then
            local upload_count=$(sudo find "$UPLOADS_DIR" -type f | wc -l)
            log_info "Uploaded files: $upload_count"
        fi
    else
        log_error "Upload directory not found: $UPLOADS_DIR"
        record_check "fail" "Upload directory"
    fi
}

# Check frontend files
check_frontend() {
    log_info "Checking frontend files..."

    if [[ -d "$DEPLOY_ROOT/web/build" ]]; then
        if [[ -f "$DEPLOY_ROOT/web/build/index.html" ]]; then
            log_success "Frontend files exist"
            record_check "pass" "Frontend files"

            # Count frontend files if verbose
            if [[ "$VERBOSE" == true ]]; then
                local file_count=$(find "$DEPLOY_ROOT/web/build" -type f | wc -l)
                local dir_size=$(du -sh "$DEPLOY_ROOT/web/build" | cut -f1)
                log_info "Frontend: $file_count files ($dir_size)"
            fi
        else
            log_error "Frontend index.html not found"
            record_check "fail" "Frontend index.html"
        fi
    else
        log_error "Frontend build directory not found"
        record_check "fail" "Frontend build directory"
    fi
}

# HTTP health checks
check_http_endpoints() {
    if [[ "$SKIP_HTTP" == true ]]; then
        log_info "Skipping HTTP health checks (--skip-http)"
        return 0
    fi

    log_info "Performing HTTP health checks..."

    if ! command -v curl &> /dev/null; then
        log_warn "curl not installed, skipping HTTP checks"
        record_check "warn" "HTTP checks (curl not found)"
        return 0
    fi

    # Check backend health endpoints
    local backend_ok=false
    for endpoint in "/health" "/api/health" "/ping" "/api/ping"; do
        if curl -sf --max-time 5 "http://localhost:${API_PORT}${endpoint}" > /dev/null 2>&1; then
            log_success "Backend HTTP response OK (${endpoint})"
            backend_ok=true
            record_check "pass" "Backend HTTP"
            break
        fi
    done

    if [[ "$backend_ok" == false ]]; then
        log_warn "Backend HTTP health endpoint not responding (may not be implemented)"
        record_check "warn" "Backend HTTP (no health endpoint)"
    fi

    # Check frontend
    if curl -sf --max-time 5 "http://localhost/" > /dev/null 2>&1; then
        log_success "Frontend HTTP response OK"
        record_check "pass" "Frontend HTTP"
    else
        log_error "Frontend HTTP response failed"
        record_check "fail" "Frontend HTTP"
    fi
}

# Check disk space
check_disk_space() {
    if [[ "$SKIP_SYSTEM" == true ]]; then
        return 0
    fi

    log_info "Checking disk space..."

    local disk_usage=$(df -h "$DEPLOY_ROOT" | awk 'NR==2 {print $5}' | sed 's/%//')

    if [[ "$disk_usage" -lt 80 ]]; then
        log_success "Disk usage: ${disk_usage}%"
        record_check "pass" "Disk space"
    elif [[ "$disk_usage" -lt 90 ]]; then
        log_warn "Disk usage high: ${disk_usage}%"
        record_check "warn" "Disk space (${disk_usage}%)"
    else
        log_error "Disk space critical: ${disk_usage}%"
        record_check "fail" "Disk space (${disk_usage}%)"
    fi
}

# Check memory
check_memory() {
    if [[ "$SKIP_SYSTEM" == true ]]; then
        return 0
    fi

    log_info "Checking memory usage..."

    local mem_available=$(free -m | awk 'NR==2{print $7}')

    if [[ "$mem_available" -gt 500 ]]; then
        log_success "Available memory: ${mem_available}MB"
        record_check "pass" "Memory"
    elif [[ "$mem_available" -gt 200 ]]; then
        log_warn "Available memory low: ${mem_available}MB"
        record_check "warn" "Memory (${mem_available}MB)"
    else
        log_error "Available memory critical: ${mem_available}MB"
        record_check "fail" "Memory (${mem_available}MB)"
    fi
}

# Print summary
print_summary() {
    echo ""
    echo "========================================"
    echo "Health Check Summary"
    echo "========================================"

    echo ""
    echo "Passed: ${#PASSED_CHECKS[@]}"
    if [[ "$VERBOSE" == true ]] && [[ ${#PASSED_CHECKS[@]} -gt 0 ]]; then
        for check in "${PASSED_CHECKS[@]}"; do
            echo "  ✓ $check"
        done
    fi

    if [[ ${#WARNING_CHECKS[@]} -gt 0 ]]; then
        echo ""
        echo "Warnings: ${#WARNING_CHECKS[@]}"
        for check in "${WARNING_CHECKS[@]}"; do
            echo "  ⚠ $check"
        done
    fi

    if [[ ${#FAILED_CHECKS[@]} -gt 0 ]]; then
        echo ""
        echo "Failed: ${#FAILED_CHECKS[@]}"
        for check in "${FAILED_CHECKS[@]}"; do
            echo "  ✗ $check"
        done
    fi

    echo ""
    echo "========================================"
    if [[ $HEALTH_STATUS -eq 0 ]]; then
        if [[ ${#WARNING_CHECKS[@]} -eq 0 ]]; then
            log_success "All health checks passed!"
        else
            log_success "Health checks passed with ${#WARNING_CHECKS[@]} warning(s)"
        fi
    else
        log_error "Health checks failed! Found ${#FAILED_CHECKS[@]} error(s)"
    fi
    echo "========================================"
}

# Main execution
main() {
    log_info "Starting health check..."
    echo ""

    check_deployment_directory
    check_nginx
    check_backend_service
    check_ports
    check_database
    check_upload_directory
    check_frontend
    check_http_endpoints

    if [[ "$SKIP_SYSTEM" == false ]]; then
        check_disk_space
        check_memory
    fi

    print_summary

    exit $HEALTH_STATUS
}

main "$@"
