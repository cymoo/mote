# Mote deployment — every target runs on your own machine and drives the
# server over SSH. Nothing here has to be run on the server by hand.
#
# First time:
#   cp deploy.env.example deploy.env   # fill in SSH_HOST / SSH_USER / DOMAIN
#   make bootstrap                     # one-time server prep (asks for sudo once)
#   make deploy
#
# Day to day:
#   make deploy      build locally, ship, restart, verify
#   make status      what is running, which releases exist
#   make logs        follow the app log
#   make rollback    back to the previous release
#
# `deploy` needs no sudo and touches no Docker: it uploads a static binary plus
# the built SPA, flips a symlink, and restarts a systemd --user service.

SHELL   := /usr/bin/env bash
SCRIPTS := ./scripts

.PHONY: help bootstrap deploy deploy-dirty rollback status logs restart backup pull-uploads nginx shell

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[0;33m%-14s\033[0m %s\n", $$1, $$2}'

bootstrap: ## One-time server prep: packages, systemd units, nginx, TLS (asks for remote sudo)
	@$(SCRIPTS)/bootstrap.sh

deploy: ## Build locally, ship the artifacts, activate and health-check
	@$(SCRIPTS)/deploy.sh

deploy-dirty: ## Same as deploy, but allows an uncommitted working tree
	@$(SCRIPTS)/deploy.sh --dirty

rollback: ## Back to the previous release (RELEASE=<id> to pick a specific one)
	@$(SCRIPTS)/ops.sh rollback "$(RELEASE)"

status: ## Service state, current release, disk and release list
	@$(SCRIPTS)/ops.sh status

logs: ## Follow the app log (journalctl)
	@$(SCRIPTS)/ops.sh logs

restart: ## Restart the app without deploying
	@$(SCRIPTS)/ops.sh restart

backup: ## Hot-backup the SQLite database on the server
	@$(SCRIPTS)/ops.sh backup

pull-uploads: ## Mirror the server's uploads/ to this machine (incremental)
	@$(SCRIPTS)/pull-uploads.sh

nginx: ## Push nginx.conf and reload (asks for remote sudo)
	@$(SCRIPTS)/nginx.sh

shell: ## Open a shell on the server in the app directory
	@$(SCRIPTS)/ops.sh shell

.DEFAULT_GOAL := help
