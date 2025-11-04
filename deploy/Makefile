# Makefile for Mote Project Deployment
# This Makefile provides convenient targets for deploying and managing the web application

# Default values - can be overridden via command line
DOMAIN ?= example.com
EMAIL ?=
BACKEND_LANG ?= go

# Script directory
SCRIPT_DIR := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))

# Source common.sh to get configuration variables
APP_NAME := mote-test
APP_USER := mote
DEPLOY_ROOT := /opt/$(APP_NAME)
SERVICE_NAME := mote-test

# Color output
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m # No Color

.PHONY: help
help: ## Show this help message
	@echo "$(GREEN)Available targets:$(NC)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(YELLOW)%-20s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(GREEN)Common variables:$(NC)"
	@echo "  DOMAIN        Domain name (default: $(DOMAIN))"
	@echo "  EMAIL         Email for SSL certificate (default: $(EMAIL))"
	@echo "  BACKEND_LANG  Backend language: rust|go|python|kotlin (default: $(BACKEND_LANG))"
	@echo ""
	@echo "$(GREEN)Examples:$(NC)"
	@echo "  make deploy DOMAIN=mysite.com EMAIL=admin@mysite.com BACKEND_LANG=rust"
	@echo "  make deploy-frontend"
	@echo "  make deploy-go"
	@echo "  make switch-to-rust"
	@echo "  make health-check"
	@echo "  make backup"
	@echo "  make logs"

# ============================================================================
# Full Deployment Targets
# ============================================================================

.PHONY: deploy
deploy: init-env setup-https setup-nginx deploy-frontend deploy-backend ## Full deployment (init → https → nginx → frontend → backend)
	@echo "$(GREEN)✓ Full deployment completed!$(NC)"

# ============================================================================
# Individual Setup Targets
# ============================================================================

.PHONY: init-env
init-env: ## Initialize deployment environment (directories, users, permissions)
	@echo "$(YELLOW)Initializing deployment environment...$(NC)"
	@bash $(SCRIPT_DIR)/init-env.sh
	@echo "$(GREEN)✓ Environment initialized$(NC)"

.PHONY: setup-https
setup-https: ## Setup HTTPS with Let's Encrypt (requires DOMAIN and optional EMAIL)
	@if [ -z "$(DOMAIN)" ]; then \
		echo "$(RED)Error: DOMAIN is required$(NC)"; \
		echo "Usage: make setup-https DOMAIN=example.com [EMAIL=admin@example.com]"; \
		exit 1; \
	fi
	@echo "$(YELLOW)Setting up HTTPS for $(DOMAIN)...$(NC)"
	@if [ -n "$(EMAIL)" ]; then \
		bash $(SCRIPT_DIR)/setup-https.sh $(DOMAIN) $(EMAIL); \
	else \
		bash $(SCRIPT_DIR)/setup-https.sh $(DOMAIN); \
	fi
	@echo "$(GREEN)✓ HTTPS setup completed$(NC)"

.PHONY: setup-nginx
setup-nginx: ## Setup and configure Nginx (requires DOMAIN)
	@if [ -z "$(DOMAIN)" ]; then \
		echo "$(RED)Error: DOMAIN is required$(NC)"; \
		echo "Usage: make setup-nginx DOMAIN=example.com"; \
		exit 1; \
	fi
	@echo "$(YELLOW)Setting up Nginx for $(DOMAIN)...$(NC)"
	@bash $(SCRIPT_DIR)/setup-nginx.sh $(DOMAIN)
	@echo "$(GREEN)✓ Nginx setup completed$(NC)"

# ============================================================================
# Dependency Installation
# ============================================================================

.PHONY: install-sys
install-sys: ## Install system dependencies
	@bash $(SCRIPT_DIR)/install-deps.sh sys

.PHONY: install-node
install-node: ## Install Node.js and npm
	@bash $(SCRIPT_DIR)/install-deps.sh node

.PHONY: install-rust
install-rust: ## Install Rust toolchain
	@bash $(SCRIPT_DIR)/install-deps.sh rust

.PHONY: install-go
install-go: ## Install Go language
	@bash $(SCRIPT_DIR)/install-deps.sh go

.PHONY: install-python
install-python: ## Install Python3 and pip
	@bash $(SCRIPT_DIR)/install-deps.sh python

.PHONY: install-jdk
install-jdk: ## Install Java and Maven
	@bash $(SCRIPT_DIR)/install-deps.sh jdk

.PHONY: install-redis
install-redis: ## Install Redis server
	@bash $(SCRIPT_DIR)/install-deps.sh redis

# ============================================================================
# Application Deployment
# ============================================================================

.PHONY: deploy-frontend
deploy-frontend: ## Deploy frontend application
	@echo "$(YELLOW)Deploying frontend...$(NC)"
	@bash $(SCRIPT_DIR)/deploy-frontend.sh
	@echo "$(GREEN)✓ Frontend deployed$(NC)"

.PHONY: deploy-backend
deploy-backend: ## Deploy backend application (requires BACKEND_LANG)
	@echo "$(YELLOW)Deploying backend ($(BACKEND_LANG))...$(NC)"
	@bash $(SCRIPT_DIR)/deploy-backend.sh $(BACKEND_LANG)
	@echo "$(GREEN)✓ Backend deployed$(NC)"

.PHONY: deploy-backend-rust
deploy-rust: ## Deploy Rust backend
	@bash $(SCRIPT_DIR)/deploy-backend.sh rust

.PHONY: deploy-backend-go
deploy-go: ## Deploy Go backend
	@bash $(SCRIPT_DIR)/deploy-backend.sh go

.PHONY: deploy-backend-python
deploy-python: ## Deploy Python backend
	@bash $(SCRIPT_DIR)/deploy-backend.sh python

.PHONY: deploy-backend-kotlin
deploy-kotlin: ## Deploy Kotlin backend
	@bash $(SCRIPT_DIR)/deploy-backend.sh kotlin

# ============================================================================
# Backend Management
# ============================================================================

.PHONY: switch-backend
switch-backend: ## Switch active backend (requires BACKEND_LANG)
	@echo "$(YELLOW)Switching backend to $(BACKEND_LANG)...$(NC)"
	@bash $(SCRIPT_DIR)/switch-backend.sh $(BACKEND_LANG)
	@echo "$(GREEN)✓ Backend switched$(NC)"

.PHONY: switch-to-rust
switch-to-rust: ## Switch to Rust backend
	@bash $(SCRIPT_DIR)/switch-backend.sh rust

.PHONY: switch-to-go
switch-to-go: ## Switch to Go backend
	@bash $(SCRIPT_DIR)/switch-backend.sh go

.PHONY: switch-to-python
switch-to-python: ## Switch to Python backend
	@bash $(SCRIPT_DIR)/switch-backend.sh python

.PHONY: switch-to-kotlin
switch-to-kotlin: ## Switch to Kotlin backend
	@bash $(SCRIPT_DIR)/switch-backend.sh kotlin

# ============================================================================
# Maintenance Targets
# ============================================================================

.PHONY: gen-password
gen-password: ## Generate application password
	@bash $(SCRIPT_DIR)/gen-password.sh

.PHONY: gen-password-force
gen-password-force: ## Force regenerate application password
	@bash $(SCRIPT_DIR)/gen-password.sh --force

.PHONY: backup
backup: ## Backup database and uploads
	@echo "$(YELLOW)Creating backup...$(NC)"
	@bash $(SCRIPT_DIR)/backup.sh
	@echo "$(GREEN)✓ Backup completed$(NC)"

.PHONY: health-check
health-check: ## Run health check on deployed application
	@bash $(SCRIPT_DIR)/check-health.sh

.PHONY: health-check-verbose
health-check-verbose: ## Run verbose health check
	@bash $(SCRIPT_DIR)/check-health.sh --verbose

# ============================================================================
# Cleanup Targets
# ============================================================================

.PHONY: clean
clean: ## Clean deployment files (keeps data and backups)
	@bash $(SCRIPT_DIR)/clean.sh

.PHONY: clean-all
clean-all: ## Clean everything including data (keeps backups)
	@bash $(SCRIPT_DIR)/clean.sh --data

.PHONY: clean-force
clean-force: ## Force clean everything including data without confirmation
	@bash $(SCRIPT_DIR)/clean.sh --data --force

.PHONY: clean-with-backups
clean-with-backups: ## Clean everything including backups
	@bash $(SCRIPT_DIR)/clean.sh --data --backups

# ============================================================================
# Service Control
# ============================================================================

.PHONY: restart-backend
restart-backend: ## Restart backend service
	@echo "$(YELLOW)Restarting backend service...$(NC)"
	@sudo systemctl restart $(SERVICE_NAME)
	@echo "$(GREEN)✓ Backend restarted$(NC)"

.PHONY: stop-backend
stop-backend: ## Stop backend service
	@echo "$(YELLOW)Stopping backend service...$(NC)"
	@sudo systemctl stop $(SERVICE_NAME)
	@echo "$(GREEN)✓ Backend stopped$(NC)"

.PHONY: start-backend
start-backend: ## Start backend service
	@echo "$(YELLOW)Starting backend service...$(NC)"
	@sudo systemctl start $(SERVICE_NAME)
	@echo "$(GREEN)✓ Backend started$(NC)"

.PHONY: restart-nginx
restart-nginx: ## Restart Nginx service
	@echo "$(YELLOW)Restarting Nginx...$(NC)"
	@sudo systemctl restart nginx
	@echo "$(GREEN)✓ Nginx restarted$(NC)"

.PHONY: status
status: ## Show service status
	@echo "$(YELLOW)Backend Service ($(SERVICE_NAME)):$(NC)"
	@sudo systemctl status $(SERVICE_NAME) --no-pager || true
	@echo ""
	@echo "$(YELLOW)Nginx Service:$(NC)"
	@sudo systemctl status nginx --no-pager || true

.PHONY: logs
logs: ## Show backend service logs
	@sudo journalctl -u $(SERVICE_NAME) -n 50 --no-pager

.PHONY: logs-follow
logs-follow: ## Follow backend service logs
	@sudo journalctl -u $(SERVICE_NAME) -f

.PHONY: logs-nginx
logs-nginx: ## Show Nginx access and error logs
	@echo "$(YELLOW)Nginx Access Log (last 20 lines):$(NC)"
	@sudo tail -n 20 /var/log/nginx/access.log || true
	@echo ""
	@echo "$(YELLOW)Nginx Error Log (last 20 lines):$(NC)"
	@sudo tail -n 20 /var/log/nginx/error.log || true

# ============================================================================
# Information & Inspection
# ============================================================================

.PHONY: info
info: ## Show deployment configuration
	@echo "$(GREEN)Deployment Configuration:$(NC)"
	@echo "  App Name:       $(APP_NAME)"
	@echo "  App User:       $(APP_USER)"
	@echo "  Deploy Root:    $(DEPLOY_ROOT)"
	@echo "  Service Name:   $(SERVICE_NAME)"
	@echo "  Domain:         $(DOMAIN)"
	@echo "  Backend Lang:   $(BACKEND_LANG)"
	@echo ""
	@echo "$(GREEN)Directory Structure:$(NC)"
	@echo "  API:            $(DEPLOY_ROOT)/api"
	@echo "  Web:            $(DEPLOY_ROOT)/web"
	@echo "  Config:         $(DEPLOY_ROOT)/config"
	@echo "  Uploads:        $(DEPLOY_ROOT)/uploads"
	@echo "  Data:           $(DEPLOY_ROOT)/data"
	@echo "  Backups:        $(DEPLOY_ROOT)/backups"

.PHONY: disk-usage
disk-usage: ## Show disk usage of deployment directories
	@echo "$(YELLOW)Deployment Directory Disk Usage:$(NC)"
	@sudo du -sh $(DEPLOY_ROOT)/* 2>/dev/null || echo "Deployment directories not found"

# ============================================================================
# Default Target
# ============================================================================

.DEFAULT_GOAL := help
