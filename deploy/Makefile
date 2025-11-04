# Makefile for multi-language backend deployment
.PHONY: help init install setup deploy-frontend deploy-backend clean status restart logs

# 默认目标
.DEFAULT_GOAL := help

# 包含共享配置
include common.sh

init: ## 初始化部署脚本(设置权限)
	@bash setup.sh

help: ## 显示帮助信息
	@echo "可用的命令:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "示例:"
	@echo "  make install              # 安装所有依赖"
	@echo "  make setup                # 初始化部署目录"
	@echo "  make deploy-frontend      # 部署前端"
	@echo "  make deploy-backend LANG=rust   # 部署Rust后端"
	@echo "  make deploy-backend LANG=go     # 部署Go后端"
	@echo "  make deploy-backend LANG=python # 部署Python后端"
	@echo "  make deploy-backend LANG=kotlin # 部署Kotlin后端"

install: ## 安装系统依赖
	@echo "安装系统依赖..."
	@sudo bash scripts/install-deps.sh

setup: ## 初始化部署目录结构
	@echo "初始化部署目录..."
	@bash scripts/setup-dirs.sh

deploy-frontend: ## 部署前端
	@echo "部署前端..."
	@bash scripts/deploy-frontend.sh

deploy-backend: ## 部署后端 (需要指定 LANG=rust|go|python|kotlin)
	@if [ -z "$(LANG)" ]; then \
		echo "错误: 请指定后端语言，例如: make deploy-backend LANG=rust"; \
		exit 1; \
	fi
	@echo "部署 $(LANG) 后端..."
	@bash scripts/deploy-backend.sh $(LANG)

deploy-all: setup deploy-frontend deploy-backend ## 完整部署 (需要指定 LANG)
	@echo "部署完成!"

clean: ## 清理部署文件
	@echo "清理部署文件..."
	@bash scripts/clean.sh

clean-all: ## 完全清理(包括数据库和上传文件)
	@echo "警告: 这将删除所有数据!"
	@read -p "确认继续? [y/N] " -n 1 -r; \
	echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		bash scripts/clean.sh --all; \
	fi

status: ## 查看服务状态
	@echo "=== Nginx 状态 ==="
	@sudo systemctl status nginx --no-pager || true
	@echo ""
	@echo "=== Mote 后端状态 ==="
	@sudo systemctl status mote --no-pager || true
	@echo ""
	@echo "=== 当前后端 ==="
	@if [ -L $(DEPLOY_ROOT)/api/current ]; then \
		echo "当前使用: $$(readlink $(DEPLOY_ROOT)/api/current)"; \
	else \
		echo "未设置"; \
	fi

restart: ## 重启服务
	@echo "重启服务..."
	@sudo systemctl restart mote
	@sudo systemctl reload nginx
	@echo "服务已重启"

logs: ## 查看后端日志
	@sudo journalctl -u mote -f

logs-nginx: ## 查看Nginx日志
	@sudo tail -f /var/log/nginx/mote-*.log

backup: ## 备份数据库和上传文件
	@bash scripts/backup.sh

switch-backend: ## 切换后端语言 (需要指定 LANG)
	@if [ -z "$(LANG)" ]; then \
		echo "错误: 请指定后端语言，例如: make switch-backend LANG=python"; \
		exit 1; \
	fi
	@bash scripts/switch-backend.sh $(LANG)

health: ## 执行健康检查
	@bash scripts/health-check.sh
