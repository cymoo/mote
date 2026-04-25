# Makefile for Mote Project Deployment
# Normal deployments happen automatically via GitHub Actions on push to main.
# These targets are for first-time server setup and emergency manual operations.

# Default values
DOMAIN ?= example.com
EMAIL ?=

# Script directory
SCRIPT_DIR := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))

APP_NAME := mote
DEPLOY_ROOT := /opt/$(APP_NAME)

# Color output
GREEN  := \033[0;32m
YELLOW := \033[0;33m
RED    := \033[0;31m
NC     := \033[0m

.PHONY: help
help: ## Show this help message
	@echo "$(GREEN)Mote Deployment Targets$(NC)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(YELLOW)%-22s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(GREEN)Variables:$(NC)"
	@echo "  DOMAIN   Domain name (default: $(DOMAIN))"
	@echo "  EMAIL    Email for SSL certificate (optional)"
	@echo ""
	@echo "$(GREEN)Typical workflow:$(NC)"
	@echo "  1. make setup-deploy-key    # Generate SSH key → add to GitHub Secrets"
	@echo "  2. make init-env            # Create directories and system user"
	@echo "  3. make install-sys         # Install nginx, sqlite3, etc."
	@echo "  4. make install-redis       # Install Redis"
	@echo "  5. make setup-nginx DOMAIN=mysite.com"
	@echo "  6. make setup-https DOMAIN=mysite.com EMAIL=me@mysite.com"
	@echo "  7. Push to main → GitHub Actions builds and deploys automatically"

# ============================================================================
# CI/CD Setup
# ============================================================================

.PHONY: setup-deploy-key
setup-deploy-key: ## Generate SSH deploy key; add the public key to GitHub Secrets (SSH_PRIVATE_KEY)
	@if [ -f $(DEPLOY_ROOT)/config/deploy_key ]; then \
		echo "$(YELLOW)Deploy key already exists: $(DEPLOY_ROOT)/config/deploy_key$(NC)"; \
	else \
		sudo mkdir -p $(DEPLOY_ROOT)/config; \
		sudo ssh-keygen -t ed25519 -f $(DEPLOY_ROOT)/config/deploy_key -N "" -C "mote-github-actions"; \
		sudo chmod 600 $(DEPLOY_ROOT)/config/deploy_key; \
		sudo chmod 644 $(DEPLOY_ROOT)/config/deploy_key.pub; \
		cat $(DEPLOY_ROOT)/config/deploy_key.pub | sudo tee -a /root/.ssh/authorized_keys > /dev/null; \
		echo "$(GREEN)✓ Deploy key generated$(NC)"; \
	fi
	@echo ""
	@echo "$(YELLOW)Add the following to GitHub Secrets as SSH_PRIVATE_KEY:$(NC)"
	@sudo cat $(DEPLOY_ROOT)/config/deploy_key
	@echo ""
	@echo "$(YELLOW)Also add SSH_KNOWN_HOSTS (run this from your local machine):$(NC)"
	@echo "  ssh-keyscan -p <port> <server-ip>"

# ============================================================================
# First-time Server Initialization
# ============================================================================

.PHONY: init-env
init-env: ## Initialize deployment environment (directories, users, permissions)
	@bash $(SCRIPT_DIR)/init-env.sh

.PHONY: setup-nginx
setup-nginx: ## Configure Nginx (requires DOMAIN)
	@if [ -z "$(DOMAIN)" ]; then \
		echo "$(RED)Error: DOMAIN is required$(NC)"; \
		echo "Usage: make setup-nginx DOMAIN=example.com"; \
		exit 1; \
	fi
	@bash $(SCRIPT_DIR)/setup-nginx.sh $(DOMAIN)

.PHONY: setup-https
setup-https: ## Setup HTTPS with Let's Encrypt (requires DOMAIN, optional EMAIL)
	@if [ -z "$(DOMAIN)" ]; then \
		echo "$(RED)Error: DOMAIN is required$(NC)"; \
		echo "Usage: make setup-https DOMAIN=example.com [EMAIL=admin@example.com]"; \
		exit 1; \
	fi
	@if [ -n "$(EMAIL)" ]; then \
		bash $(SCRIPT_DIR)/setup-https.sh $(DOMAIN) $(EMAIL); \
	else \
		bash $(SCRIPT_DIR)/setup-https.sh $(DOMAIN); \
	fi

# ============================================================================
# Dependency Installation
# ============================================================================

.PHONY: install-sys
install-sys: ## Install system dependencies (nginx, sqlite3, curl, etc.)
	@bash $(SCRIPT_DIR)/install-deps.sh sys

.PHONY: install-node
install-node: ## Install Node.js (needed only for manual frontend builds)
	@bash $(SCRIPT_DIR)/install-deps.sh node

.PHONY: install-go
install-go: ## Install Go (needed only for manual/emergency backend builds)
	@bash $(SCRIPT_DIR)/install-deps.sh go

.PHONY: install-redis
install-redis: ## Install Redis server
	@bash $(SCRIPT_DIR)/install-deps.sh redis

# ============================================================================
# Manual / Emergency Deployment
# ============================================================================

.PHONY: deploy-frontend
deploy-frontend: ## Build and deploy frontend from source (manual fallback)
	@bash $(SCRIPT_DIR)/deploy-frontend.sh

.PHONY: deploy-go
deploy-go: ## Build and deploy Go backend from source (manual/emergency fallback)
	@bash $(SCRIPT_DIR)/deploy-backend.sh

# ============================================================================
# Password Management
# ============================================================================

.PHONY: gen-password
gen-password: ## Generate application password (if not already set)
	@bash $(SCRIPT_DIR)/gen-password.sh

.PHONY: gen-password-force
gen-password-force: ## Force regenerate application password
	@bash $(SCRIPT_DIR)/gen-password.sh --force

.PHONY: view-password
view-password: ## View application password
	@bash $(SCRIPT_DIR)/get-password.sh

# ============================================================================
# Maintenance
# ============================================================================

.PHONY: backup
backup: ## Backup database and uploads
	@bash $(SCRIPT_DIR)/backup.sh

.PHONY: health-check
health-check: ## Run health check on deployed application
	@bash $(SCRIPT_DIR)/check-health.sh

# ============================================================================
# Service Control
# ============================================================================

.PHONY: restart-backend
restart-backend: ## Restart Go backend service
	@echo "$(YELLOW)Restarting $(APP_NAME)...$(NC)"
	@sudo systemctl restart $(APP_NAME)
	@echo "$(GREEN)✓ Restarted$(NC)"

.PHONY: stop-backend
stop-backend: ## Stop Go backend service
	@sudo systemctl stop $(APP_NAME)

.PHONY: start-backend
start-backend: ## Start Go backend service
	@sudo systemctl start $(APP_NAME)

.PHONY: restart-nginx
restart-nginx: ## Restart Nginx
	@sudo systemctl restart nginx

.PHONY: status
status: ## Show service status
	@echo "$(YELLOW)$(APP_NAME):$(NC)"
	@sudo systemctl status $(APP_NAME) --no-pager || true
	@echo ""
	@echo "$(YELLOW)nginx:$(NC)"
	@sudo systemctl status nginx --no-pager || true

.PHONY: logs
logs: ## Show backend service logs (last 50 lines)
	@sudo journalctl -u $(APP_NAME) -n 50 --no-pager

.PHONY: logs-follow
logs-follow: ## Follow backend service logs in real time
	@sudo journalctl -u $(APP_NAME) -f

.PHONY: logs-nginx
logs-nginx: ## Show Nginx access and error logs
	@echo "$(YELLOW)Access log:$(NC)"
	@sudo tail -n 20 /var/log/nginx/$(DOMAIN)_access.log 2>/dev/null || true
	@echo ""
	@echo "$(YELLOW)Error log:$(NC)"
	@sudo tail -n 20 /var/log/nginx/$(DOMAIN)_error.log 2>/dev/null || true

# ============================================================================
# Cleanup
# ============================================================================

.PHONY: clean
clean: ## Remove deployment files (keep data and backups)
	@bash $(SCRIPT_DIR)/clean.sh

.PHONY: clean-data
clean-data: ## Remove everything including data (keep backups)
	@bash $(SCRIPT_DIR)/clean.sh --data

.PHONY: clean-full
clean-full: ## Remove everything including backups
	@bash $(SCRIPT_DIR)/clean.sh --data --backups

# ============================================================================
# Information
# ============================================================================

.PHONY: info
info: ## Show deployment configuration
	@echo "$(GREEN)Deployment Configuration:$(NC)"
	@echo "  App Name:    $(APP_NAME)"
	@echo "  Deploy Root: $(DEPLOY_ROOT)"
	@echo ""
	@echo "$(GREEN)Directory Structure:$(NC)"
	@echo "  API:      $(DEPLOY_ROOT)/api"
	@echo "  Web:      $(DEPLOY_ROOT)/web"
	@echo "  Config:   $(DEPLOY_ROOT)/config"
	@echo "  Uploads:  $(DEPLOY_ROOT)/uploads"
	@echo "  Data:     $(DEPLOY_ROOT)/data"
	@echo "  Backups:  $(DEPLOY_ROOT)/backups"

.PHONY: disk-usage
disk-usage: ## Show disk usage of deployment directories
	@sudo du -sh $(DEPLOY_ROOT)/* 2>/dev/null || echo "Deployment directories not found"

.DEFAULT_GOAL := help
