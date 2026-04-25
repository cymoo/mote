# 部署文档

本文档介绍如何部署和管理 Mote。

**日常部署完全自动化**：推送到 `main` 分支 → GitHub Actions 构建 Go 二进制和前端 → 上传到服务器 → 重启服务。

本文档主要说明首次服务器初始化和紧急手动操作。

## 目录

- [架构概览](#架构概览)
- [GitHub Secrets 配置](#github-secrets-配置)
- [首次服务器初始化](#首次服务器初始化)
- [日常维护](#日常维护)
- [紧急手动部署](#紧急手动部署)
- [故障排查](#故障排查)
- [脚本参考](#脚本参考)

## 架构概览

```
推送到 main
    │
    ▼
GitHub Actions (.github/workflows/deploy.yml)
    ├── 构建 Go 二进制  (api-go/)
    ├── 构建前端        (frontend/)
    └── SCP 产物 → 服务器 → deploy-artifacts.sh

服务器（一次性手动初始化）
    ├── /opt/mote/api/current/mote   ← Go 二进制（每次部署替换）
    ├── /opt/mote/web/build/         ← 前端静态文件（每次部署替换）
    ├── /opt/mote/data/app.db        ← SQLite 数据库（持久化）
    ├── /opt/mote/uploads/           ← 用户上传（持久化）
    └── /opt/mote/config/.secret     ← 密码文件（生成一次）
```

Go 二进制为静态编译，服务器无需安装任何语言运行时。

## GitHub Secrets 配置

在仓库的 **Settings → Secrets and variables → Actions** 中添加：

| Secret / Variable | 说明 |
|---|---|
| `SSH_HOST` | 服务器 IP 或主机名 |
| `SSH_USER` | 具有 sudo 权限的 SSH 用户 |
| `SSH_PRIVATE_KEY` | 私钥内容（用 `make setup-deploy-key` 生成） |
| `SSH_KNOWN_HOSTS` | 服务器指纹（`ssh-keyscan -p PORT HOST`） |
| `SSH_PORT` *（变量，可选）* | SSH 端口，默认 22 |

### 生成 SSH 部署密钥

在服务器上执行：

```bash
make setup-deploy-key
```

该命令在 `/opt/mote/config/` 下生成 ed25519 密钥对，并打印私钥内容——将其粘贴到 `SSH_PRIVATE_KEY` Secret 中。

## 首次服务器初始化

在全新服务器上执行一次：

```bash
cd /path/to/mote/deploy

# 1. 创建目录结构和系统用户
make init-env

# 2. 安装系统包和 Redis
make install-sys
make install-redis

# 3. 配置 Nginx
make setup-nginx DOMAIN=example.com

# 4. 配置 HTTPS
make setup-https DOMAIN=example.com EMAIL=admin@example.com

# 5. 生成部署密钥并添加到 GitHub Secrets
make setup-deploy-key

# 6. 推送到 main，GitHub Actions 完成剩余工作
```

首次推送到 `main` 后，GitHub Actions 会：
1. 构建 Go 二进制和前端
2. 将它们上传到服务器 `/tmp/`
3. 执行 `deploy-artifacts.sh`，安装二进制、更新静态文件、启动服务

## 日常维护

### 服务管理

```bash
make status          # 查看 mote + nginx 状态
make restart-backend # 重启 Go 服务
make logs            # 查看最近 50 行日志
make logs-follow     # 实时跟踪日志
make logs-nginx      # Nginx 访问 + 错误日志
```

### 备份

```bash
make backup
```

备份保存在 `/opt/mote/backups/`，自动保留最近 5 份。

### 密码管理

```bash
make view-password       # 查看当前密码
make gen-password-force  # 重新生成密码（会重启服务）
```

### 健康检查

```bash
make health-check
```

### 磁盘使用

```bash
make disk-usage
```

## 紧急手动部署

当 GitHub Actions 不可用时，在服务器上手动构建和部署：

```bash
# 安装 Go（如未安装）
make install-go

# 构建并部署
make deploy-go
```

仅更新前端：

```bash
make install-node
make deploy-frontend
```

## 故障排查

### 服务无法启动

```bash
make logs
make status
sudo netstat -tlnp | grep 8001   # 检查端口冲突
```

### 前端无法访问

```bash
make status        # 检查 nginx
make logs-nginx
sudo nginx -t      # 验证配置
```

### HTTPS 证书问题

```bash
sudo certbot certificates
make setup-https DOMAIN=example.com EMAIL=admin@example.com
```

### 磁盘空间不足

```bash
make disk-usage
make clean          # 删除部署文件（保留数据和备份）
make clean-data     # 同时删除数据（保留备份）
make clean-full     # 删除全部
```

## 脚本参考

| 脚本 | 说明 |
|---|---|
| `common.sh` | 公共配置（路径、端口、版本）— 被所有脚本引用 |
| `init-env.sh` | 创建目录和 `mote` 系统用户 |
| `setup-https.sh` | 申请 Let's Encrypt 证书 |
| `setup-nginx.sh` | 生成并安装 Nginx 配置 |
| `setup-systemd.sh` | 生成并安装 systemd 服务单元 |
| `install-deps.sh` | 安装 sys / nodejs / go / redis |
| `deploy-artifacts.sh` | **CI 专用**：接收预编译二进制和前端，部署并重启 |
| `deploy-frontend.sh` | 手动：从源码构建并部署前端 |
| `deploy-backend.sh` | 手动/应急：从源码构建并部署 Go 后端 |
| `gen-password.sh` | 生成 `MOTE_PASSWORD` 密钥文件 |
| `get-password.sh` | 打印当前密码 |
| `backup.sh` | 备份数据库和上传文件 |
| `check-health.sh` | 健康检查 |
| `clean.sh` | 清理部署产物 |
