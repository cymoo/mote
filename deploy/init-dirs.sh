#!/bin/bash
# 初始化部署目录结构

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.env"

log_info "初始化部署目录结构..."

# 创建主目录
log_info "创建目录: $DEPLOY_ROOT"
sudo mkdir -p "$DEPLOY_ROOT"

# 创建子目录
log_info "创建子目录..."
sudo mkdir -p "$DEPLOY_ROOT"/{api,web,data,uploads,config/{nginx,systemd},backups}

# 生成随机密码并保存
# PASSWORD_FILE="$DEPLOY_ROOT/config/.password"
if [ ! -f "$SECRET_FILE" ]; then
    log_info "生成随机密码..."
    RANDOM_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-24)
    echo "MOTE_PASSWORD=$RANDOM_PASSWORD" | sudo tee "$SECRET_FILE" > /dev/null
    sudo chmod 600 "$SECRET_FILE"
    log_success "密码已保存到: $SECRET_FILE"
    log_warn "请记录此密码: $RANDOM_PASSWORD"
else
    log_info "密码文件已存在"
fi

# 设置权限
log_info "设置目录权限..."
sudo chown -R "$APP_USER:$APP_USER" "$DEPLOY_ROOT"
sudo chmod 755 "$DEPLOY_ROOT"
sudo chmod 755 "$DEPLOY_ROOT"/{api,web,data,uploads,config,backups}
sudo chmod 700 "$DEPLOY_ROOT/data"
sudo chmod 755 "$DEPLOY_ROOT/uploads"

# 创建nginx配置软链接目录(如果不存在)
if [ ! -d "/etc/nginx/sites-available" ]; then
    sudo mkdir -p /etc/nginx/sites-available
fi
if [ ! -d "/etc/nginx/sites-enabled" ]; then
    sudo mkdir -p /etc/nginx/sites-enabled
fi

log_success "目录结构初始化完成!"
