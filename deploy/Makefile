# Mote deployment Makefile
# All docker compose commands run in deploy/ on the server (where compose.yml lives).
#
# First-time setup:
#   cp .deploy.example .deploy    # then edit SERVER and REMOTE_DIR
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
NC     := \033[0m

.PHONY: help deploy backup logs logs-caddy ps restart

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  $(YELLOW)%-12s$(NC) %s\n", $$$$1, $$$$2}'

deploy: ## Backup, git pull, build frontend, rebuild images, restart (waits for healthy)
	@echo "$(YELLOW)-> Backing up...$(NC)"
	@$(MAKE) -s backup
	@echo "$(YELLOW)-> Deploying to $(SERVER):$(REMOTE_DIR)...$(NC)"
	@ssh $(SERVER) "cd $(REMOTE_DIR) && git pull origin main && \
	  mkdir -p web && \
	  docker build -t mote-frontend -f deploy/Dockerfile.frontend . && \
	  docker run --rm -v $(REMOTE_DIR)/web:/dist mote-frontend sh -c 'rm -rf /dist/* && cp -r /app/dist/. /dist/' && \
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
