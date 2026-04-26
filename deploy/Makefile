# Mote deployment Makefile — run directly on the server from deploy/
#
# First-time setup:
#   1. git clone https://github.com/cymoo/mote.git /opt/mote
#   2. cd /opt/mote/deploy
#   3. cp .env.example .env  # edit: MOTE_PASSWORD, DOMAIN
#   4. make setup
#
# Usage:
#   make deploy    -- backup, pull, rebuild, restart
#   make backup    -- backup database and uploads
#   make logs      -- tail app logs
#   make ps        -- container status

GREEN  := \033[0;32m
YELLOW := \033[0;33m
RED    := \033[0;31m
NC     := \033[0m

.PHONY: help setup deploy backup logs logs-caddy ps restart

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[0;33m%-12s\033[0m %s\n", $$1, $$2}'

setup: ## First-time: build frontend, build images, start containers
	@test -f .env || { echo "$(RED)ERROR: create .env from .env.example first$(NC)" >&2; exit 1; }
	@echo "$(YELLOW)-> Building frontend...$(NC)"
	@docker build -t mote-frontend -f Dockerfile.frontend ..
	@docker run --rm -v mote_web:/dist mote-frontend sh -c 'rm -rf /dist/* && cp -r /app/dist/. /dist/'
	@echo "$(YELLOW)-> Building and starting containers...$(NC)"
	@docker compose build
	@docker compose up -d --wait
	@echo "$(GREEN)Setup complete$(NC)"

deploy: ## Backup, git pull, rebuild images, restart
	@echo "$(YELLOW)-> Backing up...$(NC)"
	@$(MAKE) -s backup
	@echo "$(YELLOW)-> Pulling latest code...$(NC)"
	@git -C .. pull origin main
	@echo "$(YELLOW)-> Building frontend...$(NC)"
	@docker build -t mote-frontend -f Dockerfile.frontend ..
	@docker run --rm -v mote_web:/dist mote-frontend sh -c 'rm -rf /dist/* && cp -r /app/dist/. /dist/'
	@echo "$(YELLOW)-> Rebuilding and restarting containers...$(NC)"
	@docker compose build
	@docker compose up -d --remove-orphans --wait
	@echo "$(GREEN)Deploy complete$(NC)"

backup: ## Backup database and uploads
	@bash backup.sh

logs: ## Tail app container logs
	@docker compose logs -f app

logs-caddy: ## Tail Caddy container logs
	@docker compose logs -f caddy

ps: ## Show container status
	@docker compose ps

restart: ## Restart all containers
	@docker compose restart

.DEFAULT_GOAL := help
