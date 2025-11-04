# Deployment Documentation

This document describes how to deploy and manage the mote-test web application.

## Table of Contents

- [System Requirements](#system-requirements)
- [Quick Start](#quick-start)
- [Detailed Deployment Steps](#detailed-deployment-steps)
- [Daily Maintenance](#daily-maintenance)
- [Troubleshooting](#troubleshooting)
- [Script Reference](#script-reference)

## System Requirements

- **Operating System**: Ubuntu 20.04+ / Debian 11+ or other systemd-based Linux distributions
- **Permissions**: sudo access required
- **Network**: Public internet access for Let's Encrypt (if using HTTPS)
- **Domain**: Configured domain name for production deployment

## Quick Start

### Using Makefile (Recommended)

```bash
# 1. View all available commands
make help

# 2. Full deployment (with HTTPS)
make deploy DOMAIN=example.com EMAIL=admin@example.com BACKEND_LANG=go
```

### Using Scripts

```bash
cd deploy

# 1. Initialize environment
bash init-env.sh

# 2. Setup HTTPS (optional)
bash setup-https.sh example.com admin@example.com

# 3. Configure Nginx
bash setup-nginx.sh example.com

# 4. Deploy frontend
bash deploy-frontend.sh

# 5. Deploy backend (choose one language)
bash deploy-backend.sh go
```

## Detailed Deployment Steps

### 1. Environment Initialization

First, initialize the deployment environment, creating necessary directories, users, and permissions:

```bash
# Using Makefile
make init-env

# Or using script
bash init-env.sh
```

This creates the following directory structure:
```
/opt/mote-test/
├── api/          # Backend application
├── web/          # Frontend static files
├── config/       # Configuration files
├── uploads/      # User uploaded files
├── data/         # Database files
└── backups/      # Backup files
```

### 2. Install Dependencies

Install different dependency components as needed:

```bash
# Install system dependencies
make install-sys

# Install Node.js (required for frontend)
make install-node

# Install backend language runtime (choose as needed)
make install-go         # Go
make install-rust       # Rust
make install-python     # Python
make install-jdk        # Java/Kotlin

# Or install multiple components at once
make install-deps COMPONENTS='sys node go python'
```

### 3. Configure HTTPS

Configure SSL certificate using Let's Encrypt:

```bash
# Using Makefile
make setup-https DOMAIN=example.com EMAIL=admin@example.com

# Or using script
bash setup-https.sh example.com admin@example.com
```

**Note**: 
- Domain must be properly resolved to the server
- Ports 80 and 443 must be open
- Email address is optional

### 4. Configure Nginx

Setup Nginx web server:

```bash
# Using Makefile
make setup-nginx DOMAIN=example.com

# Or using script
bash setup-nginx.sh example.com
```

### 5. Deploy Application

#### Deploy Frontend

```bash
# Full deployment (install dependencies + build)
make deploy-frontend
```

#### Deploy Backend

Choose one backend language to deploy:

```bash
# Go backend
make deploy-backend-go

# Rust backend
make deploy-backend-rust

# Python backend
make deploy-backend-python

# Kotlin backend
make deploy-backend-kotlin

# Or use variable
make deploy-backend BACKEND_LANG=go
```

### 6. Verify Deployment

Check if deployment was successful:

```bash
# Check service status
make status

# Run health check
make health-check

# Verbose health check
make health-check-verbose

# View configuration info
make info

# Check directories
make check-dirs
```

## Daily Maintenance

### Update Application

#### Update Frontend

When frontend code is updated:

```bash
make update-frontend
```

This will automatically:
1. Build new frontend
2. Deploy to web directory
3. Reload Nginx

#### Update Backend

When backend code is updated:

```bash
make update-backend BACKEND_LANG=go
```

This will automatically:
1. Build new backend
2. Deploy to api directory
3. Restart backend service

#### Update Both Frontend and Backend

```bash
make redeploy BACKEND_LANG=go
```

### Switch Backend Implementation

If you have multiple backend implementations, you can easily switch between them:

```bash
# Switch to Go backend
make switch-to-go

# Switch to Python backend
make switch-to-python

# Switch to Rust backend
make switch-to-rust

# Switch to Kotlin backend
make switch-to-kotlin

# Or use variable
make switch-backend BACKEND_LANG=python
```

### Service Management

```bash
# Restart services
make restart-backend
make restart-nginx

# Start/stop backend
make start-backend
make stop-backend

# View status
make status
```

### View Logs

```bash
# View backend logs (last 50 entries)
make logs

# Follow backend logs in real-time
make logs-follow

# View Nginx logs
make logs-nginx
```

### Backup

Regularly backup database and uploaded files:

```bash
make backup
```

Backup files will be saved in `/opt/mote-test/backups/` directory, automatically keeping the last 5 backups.

### Password Management

```bash
# Generate application password (if not exists)
make gen-password

# Force regenerate password
make gen-password-force
```

Password will be saved in `/opt/mote-test/config/.secret` file.

## Troubleshooting

### Check Service Status

```bash
# View service status
make status

# View logs
make logs
make logs-nginx

# Run health check
make health-check-verbose
```

### Common Issues

#### 1. Backend Service Won't Start

```bash
# View detailed logs
make logs

# Check configuration
make info

# Check if port is in use
sudo netstat -tlnp | grep 8001
```

#### 2. Frontend Page Not Accessible

```bash
# Check Nginx status
make status

# View Nginx logs
make logs-nginx

# Test Nginx configuration
sudo nginx -t

# Check file permissions
ls -la /opt/mote-test/web/
```

#### 3. HTTPS Certificate Issues

```bash
# Check certificate
sudo certbot certificates

# Reapply certificate
make setup-https DOMAIN=example.com EMAIL=admin@example.com
```

#### 4. Disk Space Insufficient

```bash
# Check disk usage
make disk-usage

# Clean old backups
make clean-with-backups --force
```

### Redeploy

If you encounter unresolvable issues, you can clean and redeploy:

```bash
# Clean deployment files (keep data and backups)
make clean

# Clean everything (including data, keep backups)
make clean-all

# Clean everything (including backups)
make clean-with-backups

# Then redeploy
make deploy DOMAIN=example.com BACKEND_LANG=go
```

## Script Reference

### Core Scripts

| Script | Description | Usage |
|--------|-------------|-------|
| `common.sh` | Common configuration file | Sourced by other scripts |
| `init-env.sh` | Initialize deployment environment | `bash init-env.sh` |
| `setup-https.sh` | Configure HTTPS | `bash setup-https.sh <domain> [email]` |
| `setup-nginx.sh` | Configure Nginx | `bash setup-nginx.sh <domain>` |
| `setup-systemd.sh` | Configure systemd service | `bash setup-systemd.sh <lang>` |
| `install-deps.sh` | Install dependencies | `bash install-deps.sh <component>...` |
| `deploy-frontend.sh` | Deploy frontend | `bash deploy-frontend.sh [options]` |
| `deploy-backend.sh` | Deploy backend | `bash deploy-backend.sh <lang>` |
| `switch-backend.sh` | Switch backend | `bash switch-backend.sh <lang>` |

### Maintenance Scripts

| Script | Description | Usage |
|--------|-------------|-------|
| `backup.sh` | Backup data | `bash backup.sh` |
| `check-health.sh` | Health check | `bash check-health.sh [options]` |
| `gen-password.sh` | Generate password | `bash gen-password.sh [options]` |
| `clean.sh` | Clean deployment | `bash clean.sh [options]` |

### Supported Backend Languages

- `rust` / `rs` - Rust
- `go` / `golang` - Go
- `python` / `py` - Python
- `kotlin` / `kt` - Kotlin/Java

### Installable Dependency Components

- `sys` / `system` - System dependencies (curl, wget, git, nginx, sqlite3, etc.)
- `node` / `nodejs` - Node.js and npm
- `rust` - Rust toolchain
- `go` / `golang` - Go language
- `python` / `py` - Python3 and pip
- `jdk` / `java` - Java and Maven
- `redis` - Redis server

## Configuration

Main configuration is defined in `common.sh`:

```bash
# Application configuration
APP_NAME=mote-test
APP_USER=mote
DEPLOY_ROOT=/opt/mote-test

# API configuration
API_ADDR=127.0.0.1
API_PORT=8001

# URL paths
MEMO_URL=/memo
BLOG_URL=/shared

# Backup settings
MAX_BACKUPS=5

# Mirror acceleration
CHINA_MIRROR=true  # Use China mirrors for faster downloads
```

## Security Recommendations

1. **Regular Updates**: Keep system and dependencies up to date
2. **Backup Strategy**: Use `make backup` to regularly backup data
3. **Password Management**: Securely store `/opt/mote-test/config/.secret` file
4. **Firewall**: Only open necessary ports (80, 443)
5. **Monitoring**: Regularly run `make health-check` to check system status
6. **Log Review**: Regularly review logs to detect anomalies

## Performance Optimization

1. **Frontend**: Use CDN to accelerate static resources
2. **Backend**: Choose appropriate backend implementation based on load
3. **Database**: Regularly clean and optimize database
4. **Nginx**: Enable gzip compression and browser caching
5. **Monitoring**: Use `make disk-usage` to monitor disk space

## License

The deployment scripts for this project follow the project's main license.

## Support

If you have questions or suggestions:
1. Check the troubleshooting section
2. Run `make health-check-verbose` for detailed diagnostics
3. Review log files
4. Submit an issue

---

**Last Updated**: 2025-11-05
