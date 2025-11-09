# 部署文档

本文档介绍如何部署和管理 Mote Web 应用程序。

## 目录

- [系统要求](#系统要求)
- [快速开始](#快速开始)
- [详细部署步骤](#详细部署步骤)
- [日常维护](#日常维护)
- [故障排查](#故障排查)
- [脚本参考](#脚本参考)

## 系统要求

- **操作系统**: Ubuntu 20.04+ / Debian 11+ 或其他基于 systemd 的 Linux 发行版
- **权限**: sudo 访问权限
- **网络**: 外网访问
- **域名**: 已配置 DNS 解析
- **端口**: 80 和 443

## 快速开始

### 使用 Makefile（推荐）

```bash
# 1. 查看所有可用命令
make help

# 2. 完整部署（包含 HTTPS）
make deploy DOMAIN=example.com EMAIL=admin@example.com BACKEND_LANG=go
```

### 使用脚本

```bash
cd deploy

# 1. 初始化环境
bash init-env.sh

# 2. 设置 HTTPS
bash setup-https.sh example.com admin@example.com

# 3. 配置 Nginx
bash setup-nginx.sh example.com

# 4. 部署前端
bash deploy-frontend.sh

# 5. 部署后端（选择一种语言）
bash deploy-backend.sh go
```

## 详细部署步骤

### 1. 环境初始化

首先初始化部署环境，创建必要的目录、用户和权限：

```bash
# 使用 Makefile
make init-env

# 或使用脚本
bash init-env.sh
```

这将创建以下目录结构：
```
/opt/mote/
├── api/          # 后端应用
├── web/          # 前端静态文件
├── config/       # 配置文件
├── uploads/      # 用户上传文件
├── data/         # 数据库文件
└── backups/      # 备份文件
```

### 2. 安装依赖

根据需要安装不同的依赖组件：

```bash
# 安装系统依赖
make install-sys

# 安装 Node.js（前端需要）
make install-node

# 安装后端语言环境（根据需要选择）
make install-go         # Go
make install-rust       # Rust
make install-python     # Python
make install-jdk        # Java/Kotlin

# 或一次性安装多个组件
make install-deps COMPONENTS='sys node go python'
```

### 3. 配置 HTTPS

使用 Let's Encrypt 配置 SSL 证书：

```bash
# 使用 Makefile
make setup-https DOMAIN=example.com EMAIL=admin@example.com

# 或使用脚本
bash setup-https.sh example.com admin@example.com
```

**注意**: 
- 域名必须已正确解析到服务器
- 端口 80 和 443 必须开放
- 邮箱地址为可选参数

### 4. 配置 Nginx

设置 Nginx Web 服务器：

```bash
# 使用 Makefile
make setup-nginx DOMAIN=example.com

# 或使用脚本
bash setup-nginx.sh example.com
```

### 5. 部署应用

#### 部署前端

```bash
make deploy-frontend
```

#### 部署后端

选择一种后端语言进行部署：

```bash
# Go 后端
make deploy-backend-go

# Rust 后端
make deploy-backend-rust

# Python 后端
make deploy-backend-python

# Kotlin 后端
make deploy-backend-kotlin

# 或使用变量
make deploy-backend BACKEND_LANG=go
```

### 6. 验证部署

检查部署是否成功：

```bash
# 检查服务状态
make status

# 运行健康检查
make health-check

# 查看配置信息
make info
```

## 日常维护

### 更新应用

#### 更新前端

当前端代码有更新时：

```bash
make update-frontend
```

这将自动：
1. 构建新的前端
2. 部署到 web 目录
3. 重新加载 Nginx

#### 更新后端

当后端代码有更新时：

```bash
make update-backend BACKEND_LANG=go
```

这将自动：
1. 构建新的后端
2. 部署到 api 目录
3. 重启后端服务

#### 同时更新前后端

```bash
make redeploy BACKEND_LANG=go
```

### 切换后端实现

如果有多个后端实现，可以轻松切换：

```bash
# 切换到 Go 后端
make switch-to-go

# 切换到 Python 后端
make switch-to-python

# 切换到 Rust 后端
make switch-to-rust

# 切换到 Kotlin 后端
make switch-to-kotlin

# 或使用变量
make switch-backend BACKEND_LANG=python
```

### 服务管理

```bash
# 重启服务
make restart-backend
make restart-nginx

# 启动/停止后端
make start-backend
make stop-backend

# 查看状态
make status
```

### 日志查看

```bash
# 查看后端日志（最近 50 条）
make logs

# 实时跟踪后端日志
make logs-follow

# 查看 Nginx 日志
make logs-nginx
```

### 备份

定期备份数据库和上传文件：

```bash
make backup
```

备份文件将保存在 `/opt/mote/backups/` 目录，自动保留最近 5 个备份。

### 密码管理

```bash
# 生成应用密码（如果不存在）
make gen-password

# 强制重新生成密码
make gen-password-force
```

密码将保存在 `/opt/mote/config/.secret` 文件中。

## 故障排查

### 检查服务状态

```bash
# 查看服务状态
make status

# 查看日志
make logs
make logs-nginx

# 运行健康检查
make health-check-verbose
```

### 常见问题

#### 1. 后端服务无法启动

```bash
# 查看详细日志
make logs

# 检查配置
make info

# 检查端口是否被占用
sudo netstat -tlnp | grep 8001
```

#### 2. 前端页面无法访问

```bash
# 检查 Nginx 状态
make status

# 查看 Nginx 日志
make logs-nginx

# 测试 Nginx 配置
sudo nginx -t

# 检查文件权限
ls -la /opt/mote/web/
```

#### 3. HTTPS 证书问题

```bash
# 检查证书
sudo certbot certificates

# 重新申请证书
make setup-https DOMAIN=example.com EMAIL=admin@example.com
```

#### 4. 磁盘空间不足

```bash
# 查看磁盘使用情况
make disk-usage

# 清理旧备份
make clean-with-backups --force
```

### 重新部署

如果遇到无法解决的问题，可以清理并重新部署：

```bash
# 清理部署文件（保留数据和备份）
make clean

# 清理所有（包括数据，保留备份）
make clean-all

# 清理所有（包括备份）
make clean-with-backups

# 然后重新部署
make deploy DOMAIN=example.com BACKEND_LANG=go
```

## 脚本参考

### 核心脚本

| 脚本 | 描述 | 用法 |
|------|------|------|
| `common.sh` | 公共配置文件 | 被其他脚本引用 |
| `init-env.sh` | 初始化部署环境 | `bash init-env.sh` |
| `setup-https.sh` | 配置 HTTPS | `bash setup-https.sh <domain> [email]` |
| `setup-nginx.sh` | 配置 Nginx | `bash setup-nginx.sh <domain>` |
| `setup-systemd.sh` | 配置 systemd 服务 | `bash setup-systemd.sh <lang>` |
| `install-deps.sh` | 安装依赖 | `bash install-deps.sh <component>...` |
| `deploy-frontend.sh` | 部署前端 | `bash deploy-frontend.sh [options]` |
| `deploy-backend.sh` | 部署后端 | `bash deploy-backend.sh <lang>` |
| `switch-backend.sh` | 切换后端 | `bash switch-backend.sh <lang>` |

### 维护脚本

| 脚本 | 描述 | 用法 |
|------|------|------|
| `backup.sh` | 备份数据 | `bash backup.sh` |
| `check-health.sh` | 健康检查 | `bash check-health.sh [options]` |
| `gen-password.sh` | 生成密码 | `bash gen-password.sh [options]` |
| `clean.sh` | 清理部署 | `bash clean.sh [options]` |

### 支持的后端语言

- `rust` / `rs` - Rust
- `go` / `golang` - Go
- `python` / `py` - Python
- `kotlin` / `kt` - Kotlin/Java

### 可安装的依赖组件

- `sys` / `system` - 系统依赖（curl, wget, git, nginx, sqlite3 等）
- `node` / `nodejs` - Node.js 和 npm
- `rust` - Rust 工具链
- `go` / `golang` - Go 语言
- `python` / `py` - Python3 和 pip
- `jdk` / `java` - Java 和 Maven
- `redis` - Redis 服务器

## 配置说明

主要配置在 `common.sh` 中定义：

```bash
# 应用配置
APP_NAME=mote
APP_USER=mote
DEPLOY_ROOT=/opt/mote

# API 配置
API_ADDR=127.0.0.1
API_PORT=8001

# URL 路径
MEMO_URL=/memo
BLOG_URL=/shared

# 备份设置
MAX_BACKUPS=5

# 镜像加速
CHINA_MIRROR=true  # 使用国内镜像加速下载
```

## 安全建议

1. **定期更新**: 保持系统和依赖的最新版本
2. **备份策略**: 使用 `make backup` 定期备份数据
3. **密码管理**: 妥善保管 `/opt/mote/config/.secret` 文件
4. **防火墙**: 只开放必要的端口（80, 443）
5. **监控**: 定期运行 `make health-check` 检查系统状态
6. **日志审查**: 定期查看日志以发现异常

## 性能优化

1. **前端**: 使用 CDN 加速静态资源
2. **后端**: 根据负载选择合适的后端实现
3. **数据库**: 定期清理和优化数据库
4. **Nginx**: 启用 gzip 压缩和浏览器缓存
5. **监控**: 使用 `make disk-usage` 监控磁盘空间

---

**最后更新**: 2025-11-05
