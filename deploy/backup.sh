#!/bin/bash
# 备份数据库和上传文件

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.env"

BACKUP_NAME="backup-$(date +%Y%m%d-%H%M%S)"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"

log_info "开始备份..."

# 创建备份目录
sudo mkdir -p "$BACKUP_PATH"

# 备份数据库
if [ -f "$DB_FILE" ]; then
    log_info "备份数据库..."
    sudo sqlite3 "$DB_FILE" ".backup '$BACKUP_PATH/app.db'"
    log_success "数据库已备份"
else
    log_warn "数据库文件不存在: $DB_FILE"
fi

# 备份上传文件
if [ -d "$UPLOADS_DIR" ] && [ "$(sudo ls -A $UPLOADS_DIR 2>/dev/null)" ]; then
    log_info "备份上传文件..."
    sudo cp -r "$UPLOADS_DIR" "$BACKUP_PATH/"
    log_success "上传文件已备份"
else
    log_warn "上传目录为空或不存在"
fi

# 备份配置文件
if [ -f "$DEPLOY_ROOT/config/.password" ]; then
    log_info "备份密码文件..."
    sudo cp "$DEPLOY_ROOT/config/.password" "$BACKUP_PATH/"
fi

# 获取当前后端类型
if [ -L "$DEPLOY_ROOT/api/current" ]; then
    CURRENT_BACKEND=$(basename "$(readlink "$DEPLOY_ROOT/api/current")")
    echo "$CURRENT_BACKEND" | sudo tee "$BACKUP_PATH/backend.txt" > /dev/null
    log_info "当前后端: $CURRENT_BACKEND"
fi

# 压缩备份
log_info "压缩备份..."
cd "$BACKUP_DIR"
sudo tar -czf "${BACKUP_NAME}.tar.gz" "$BACKUP_NAME"
sudo rm -rf "$BACKUP_NAME"

# 设置权限
sudo chown -R "$APP_USER:$APP_USER" "$BACKUP_DIR"
sudo chmod 640 "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"

log_success "备份完成!"
log_info "备份文件: ${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"

# 显示备份大小
BACKUP_SIZE=$(sudo du -h "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" | cut -f1)
log_info "备份大小: $BACKUP_SIZE"

# 清理旧备份(保留最近10个)
BACKUP_COUNT=$(sudo ls -1 "$BACKUP_DIR"/*.tar.gz 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt 10 ]; then
    log_info "清理旧备份..."
    sudo ls -1t "$BACKUP_DIR"/*.tar.gz | tail -n +11 | xargs sudo rm -f
    log_info "已保留最近10个备份"
fi
