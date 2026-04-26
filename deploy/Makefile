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

APP_DIR         := $(abspath ..)
WEB_DIR         := $(APP_DIR)/web
NGINX_CONF      := /etc/nginx/conf.d/mote.conf
CERTBOT_WEBROOT := /var/www/certbot
DOMAIN          := $(shell grep '^DOMAIN=' .env 2>/dev/null | cut -d= -f2)
# Use sudo only when not already root
SUDO            := $(if $(filter 0,$(shell id -u)),,sudo)

.PHONY: help setup deploy backup logs ps restart

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[0;33m%-12s\033[0m %s\n", $$1, $$2}'

setup: ## First-time: build, start containers, configure nginx + TLS
	@test -f .env || { echo "$(RED)ERROR: create .env from .env.example first$(NC)" >&2; exit 1; }
	@test -n "$(DOMAIN)" || { echo "$(RED)ERROR: DOMAIN not set in .env$(NC)" >&2; exit 1; }
	@command -v nginx   > /dev/null 2>&1 || { echo "$(RED)ERROR: nginx not installed$(NC)" >&2; exit 1; }
	@command -v certbot > /dev/null 2>&1 || { echo "$(RED)ERROR: certbot not installed$(NC)" >&2; exit 1; }
	@echo "$(YELLOW)-> Creating directories...$(NC)"
	@$(SUDO) mkdir -p $(APP_DIR)/data $(APP_DIR)/uploads $(WEB_DIR) $(CERTBOT_WEBROOT)
	@echo "$(YELLOW)-> Building frontend...$(NC)"
	@docker build -t mote-frontend -f Dockerfile.frontend ..
	@docker run --rm -v $(WEB_DIR):/dist mote-frontend sh -c 'rm -rf /dist/* && cp -r /app/dist/. /dist/'
	@echo "$(YELLOW)-> Building and starting containers...$(NC)"
	@docker compose build
	@docker compose up -d --wait
	@echo "$(YELLOW)-> Configuring nginx (HTTP only for ACME challenge)...$(NC)"
	@$(SUDO) rm -f /etc/nginx/sites-enabled/default
	@sed -e 's|__DOMAIN__|$(DOMAIN)|g' nginx-init.conf | $(SUDO) tee $(NGINX_CONF) > /dev/null
	@$(SUDO) nginx -t && ($(SUDO) systemctl reload nginx 2>/dev/null || $(SUDO) systemctl start nginx)
	@echo "$(YELLOW)-> Obtaining TLS certificate...$(NC)"
	@$(SUDO) certbot certonly --webroot -w $(CERTBOT_WEBROOT) -d $(DOMAIN) \
	    --agree-tos --non-interactive --register-unsafely-without-email \
	    --keep-until-expiring \
	    --deploy-hook "systemctl reload nginx"
	@echo "$(YELLOW)-> Enabling HTTPS nginx config...$(NC)"
	@sed -e 's|__DOMAIN__|$(DOMAIN)|g' \
	     -e 's|__APP_DIR__|$(APP_DIR)|g' \
	     nginx.conf | $(SUDO) tee $(NGINX_CONF) > /dev/null
	@$(SUDO) nginx -t && $(SUDO) systemctl reload nginx
	@echo "$(GREEN)Setup complete — visit https://$(DOMAIN)$(NC)"

deploy: ## Backup, git pull, rebuild images, restart, refresh nginx config
	@echo "$(YELLOW)-> Backing up...$(NC)"
	@$(MAKE) -s backup
	@echo "$(YELLOW)-> Pulling latest code...$(NC)"
	@git -C .. pull origin main
	@echo "$(YELLOW)-> Building frontend...$(NC)"
	@docker build -t mote-frontend -f Dockerfile.frontend ..
	@docker run --rm -v $(WEB_DIR):/dist mote-frontend sh -c 'rm -rf /dist/* && cp -r /app/dist/. /dist/'
	@echo "$(YELLOW)-> Rebuilding and restarting containers...$(NC)"
	@docker compose build
	@docker compose up -d --remove-orphans --wait
	@echo "$(YELLOW)-> Refreshing nginx config...$(NC)"
	@sed -e 's|__DOMAIN__|$(DOMAIN)|g' \
	     -e 's|__APP_DIR__|$(APP_DIR)|g' \
	     nginx.conf | $(SUDO) tee $(NGINX_CONF) > /dev/null
	@$(SUDO) nginx -t && $(SUDO) systemctl reload nginx
	@echo "$(GREEN)Deploy complete$(NC)"

backup: ## Backup database and uploads
	@bash backup.sh

logs: ## Tail app container logs
	@docker compose logs -f app

ps: ## Show container status
	@docker compose ps

restart: ## Restart all containers
	@docker compose restart

.DEFAULT_GOAL := help
