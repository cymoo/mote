# Mote deployment Makefile
# All commands run locally and SSH to the server as needed.
#
# First-time setup (all from local, inside deploy/):
#   1. cp .deploy.example .deploy  # edit: SERVER, REMOTE_DIR
#   2. cp .env.example .env        # edit: MOTE_PASSWORD, DOMAIN
#   3. make setup
#
# Usage:
#   make deploy    -- backup, pull, rebuild, restart (one-click deploy)
#   make backup    -- backup database and uploads
#   make logs      -- tail app logs
#   make ps        -- container status

-include .deploy
SERVER     ?= $(error SERVER is not set -- copy .deploy.example to .deploy)
REMOTE_DIR ?= /opt/mote

GREEN  := \033[0;32m
YELLOW := \033[0;33m
RED    := \033[0;31m
NC     := \033[0m

.PHONY: help setup deploy backup logs logs-caddy ps restart

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  $(YELLOW)%-12s$(NC) %s\n", $$$$1, $$$$2}'

setup: ## First-time: clone repo on server, upload .env, build and start
	@test -f .env || { echo "$(RED)ERROR: create .env from .env.example first$(NC)" >&2; exit 1; }
	@echo "$(YELLOW)-> Cloning repo on server (if needed)...$(NC)"
	@ssh $(SERVER) "[ -d $(REMOTE_DIR)/.git ] || git clone https://github.com/cymoo/mote.git $(REMOTE_DIR)"
	@echo "$(YELLOW)-> Uploading .env...$(NC)"
	@scp -q .env $(SERVER):$(REMOTE_DIR)/deploy/.env
	@ssh $(SERVER) "chmod 600 $(REMOTE_DIR)/deploy/.env"
	@echo "$(YELLOW)-> Building frontend...$(NC)"
	@ssh $(SERVER) "cd $(REMOTE_DIR) && \
	  docker build -t mote-frontend -f deploy/Dockerfile.frontend . && \
	  docker run --rm -v mote_web:/dist mote-frontend sh -c 'rm -rf /dist/* && cp -r /app/dist/. /dist/'"
	@echo "$(YELLOW)-> Building and starting containers...$(NC)"
	@ssh $(SERVER) "cd $(REMOTE_DIR)/deploy && docker compose build && docker compose up -d --wait"
	@echo "$(GREEN)Setup complete$(NC)"

deploy: ## Backup, git pull, build frontend, rebuild images, restart (waits for healthy)
	@echo "$(YELLOW)-> Backing up...$(NC)"
	@$(MAKE) -s backup
	@echo "$(YELLOW)-> Deploying to $(SERVER):$(REMOTE_DIR)...$(NC)"
	@ssh $(SERVER) "cd $(REMOTE_DIR) && git pull origin main && \
	  docker build -t mote-frontend -f deploy/Dockerfile.frontend . && \
	  docker run --rm -v mote_web:/dist mote-frontend sh -c 'rm -rf /dist/* && cp -r /app/dist/. /dist/' && \
	  cd deploy && docker compose build && \
	  docker compose up -d --remove-orphans --wait"
	@echo "$(GREEN)Deploy complete$(NC)"

backup: ## Backup database and uploads on the server
	@ssh $(SERVER) "cd $(REMOTE_DIR)/deploy && bash backup.sh"

logs: ## Tail app container logs
	@ssh $(SERVER) "cd $(REMOTE_DIR)/deploy && docker compose logs -f app"

logs-caddy: ## Tail Caddy container logs
	@ssh $(SERVER) "cd $(REMOTE_DIR)/deploy && docker compose logs -f caddy"

ps: ## Show container status
	@ssh $(SERVER) "cd $(REMOTE_DIR)/deploy && docker compose ps"

restart: ## Restart all containers
	@ssh $(SERVER) "cd $(REMOTE_DIR)/deploy && docker compose restart"

.DEFAULT_GOAL := help
