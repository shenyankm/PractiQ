# Caddy 服务器配置指南

为 OpenWook Next.js 全栈应用配置的 Caddy 反向代理方案。

## 快速开始

### 1. 安装 Caddy

```bash
# Ubuntu/Debian
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# 验证安装
caddy version
```

### 2. 启动 Next.js 应用

开发环境可以使用 `pnpm dev`。生产环境不要把公开域名代理到 `next dev`，否则浏览器会加载 `/_next/webpack-hmr` 并持续尝试连接 HMR WebSocket。

```bash
# 生产模式
pnpm build
NODE_ENV=production OPENWOOK_HOST=127.0.0.1 PORT=3000 pnpm start:prod
```

推荐用仓库提供的 `openwook.service` 托管单个生产 Next.js 进程。确保应用只监听 `127.0.0.1:3000`，由 Caddy 对外提供 HTTPS。

高并发场景推荐使用 `openwook@.service` 模板启动多个 Next.js 实例：

```bash
sudo systemctl start openwook@3000 openwook@3001 openwook@3002 openwook@3003
```

Caddy 会把请求轮询转发到 `127.0.0.1:3000`、`3001`、`3002`、`3003`。

### 3. 启动 Caddy

```bash
# 使用管理脚本
./caddy-manage.sh start

# 或直接运行
export OPENWOOK_ROOT=/home/ubuntu/projects/openwook
caddy run --config /etc/caddy/Caddyfile.openwook --adapter caddyfile
```

访问 `http://localhost` 即可通过 Caddy 访问应用。

## 文件说明

| 文件 | 路径 | 用途 |
|------|------|------|
| `Caddyfile.openwook` | `/etc/caddy/Caddyfile.openwook` | 开发环境配置 (HTTP) |
| `Caddyfile.dev` | `/etc/caddy/Caddyfile.dev` | 完整开发环境配置 (HTTP) |
| `Caddyfile.prod` | `/etc/caddy/Caddyfile.prod` | 生产环境配置 (HTTPS) |
| `Caddyfile.ip` | `/etc/caddy/Caddyfile.ip` | IP 访问模式配置 |
| `caddy-manage.sh` | 项目目录 | 服务管理脚本 |
| `openwook.service` | 项目目录 | Next.js 单实例生产应用 systemd 服务模板 |
| `openwook@.service` | 项目目录 | Next.js 多实例 systemd 模板，实例名即监听端口 |
| `caddy-openwook.service` | 项目目录 | Caddy systemd 服务配置模板 |

## 配置详解

### 开发配置 (`/etc/caddy/Caddyfile.openwook`)

- **端口**: 80
- **协议**: HTTP
- **代理目标**: `127.0.0.1:3000`、`3001`、`3002`、`3003`
- **CORS**: 全开放 (`*`)
- **静态文件**: 直接从 `public/` 目录提供
- **缓存**: Next.js 静态资源长期缓存

### 生产配置 (`/etc/caddy/Caddyfile.prod`)

- **端口**: 443 (HTTPS) + 80 (HTTP 重定向)
- **SSL**: 自动证书 (Let's Encrypt) 或内部证书
- **安全头**: HSTS、CSP、X-Frame-Options 等
- **CORS**: 限制特定域名
- **压缩**: zstd + gzip
- **日志**: JSON 格式，按大小轮转

## 常用操作

### 使用管理脚本

```bash
# 查看所有命令
./caddy-manage.sh

# 启动
./caddy-manage.sh start

# 停止
./caddy-manage.sh stop

# 重启
./caddy-manage.sh restart

# 查看状态
./caddy-manage.sh status

# 重载配置 (不中断服务)
./caddy-manage.sh reload

# 查看日志
./caddy-manage.sh logs

# 验证配置
./caddy-manage.sh validate
```

### 使用 systemd (推荐用于生产)

```bash
# 复制配置和服务文件
sudo cp Caddyfile.openwook /etc/caddy/Caddyfile.openwook
sudo cp openwook.service openwook@.service caddy-openwook.service /etc/systemd/system/

# 构建生产包
pnpm build

# 重新加载 systemd
sudo systemctl daemon-reload

# 启动服务
sudo systemctl start openwook
sudo systemctl start caddy-openwook

# 开机自启
sudo systemctl enable openwook caddy-openwook

# 查看状态
sudo systemctl status openwook caddy-openwook

# 查看日志
sudo journalctl -u openwook -u caddy-openwook -f
```

### 使用 systemd 多实例运行 Next.js (推荐用于高并发)

`openwook@.service` 是 systemd 模板服务，`@` 后面的实例名就是端口号。例如 `openwook@3001` 会以 `PORT=3001` 启动一个 Next.js 生产进程。

```bash
# 复制配置和服务模板
sudo cp Caddyfile.openwook /etc/caddy/Caddyfile.openwook
sudo cp openwook@.service caddy-openwook.service /etc/systemd/system/

# 构建生产包
pnpm build

# 重新加载 systemd
sudo systemctl daemon-reload

# 启动 4 个 Next.js 实例
sudo systemctl start openwook@3000 openwook@3001 openwook@3002 openwook@3003
sudo systemctl start caddy-openwook

# 开机自启
sudo systemctl enable openwook@3000 openwook@3001 openwook@3002 openwook@3003 caddy-openwook

# 查看状态
sudo systemctl status openwook@3000 openwook@3001 openwook@3002 openwook@3003 caddy-openwook

# 查看日志
sudo journalctl -u openwook@3000 -u openwook@3001 -u openwook@3002 -u openwook@3003 -u caddy-openwook -f
```

也可以用仓库脚本一次完成复制模板、构建、启动多实例和重载 Caddy：

```bash
sudo OPENWOOK_PORTS=3000,3001,3002,3003 scripts/deploy/openwook-systemd.sh
```

上线或变更实例数后，先验证 Caddy 配置，再平滑重载：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile.openwook --adapter caddyfile
sudo systemctl reload caddy-openwook
```

> 注意：每个 Next.js 实例都会创建自己的 PostgreSQL 连接池。多实例部署时建议显式设置 `POSTGRES_POOL_MAX=5..8` 起步；4 个实例约等于最多 20-32 条应用侧数据库连接。若数据库 `max_connections` 较小或还有 worker/运维连接，应降低 `POSTGRES_POOL_MAX` 或引入 PgBouncer。

## SSL 证书配置

### 方式 1: 自动 Let's Encrypt (公网域名)

```caddy
yourdomain.com {
    tls admin@yourdomain.com
    ...
}
```

无需其他配置，Caddy 会自动申请和续期证书。

### 方式 2: 内部证书 (本地测试)

```caddy
openwook.local {
    tls internal
    ...
}
```

访问时需要信任自签名证书。

### 方式 3: 自有证书

```caddy
yourdomain.com {
    tls /path/to/cert.pem /path/to/key.pem
    ...
}
```

### 本地 hosts 配置 (测试用)

```bash
# /etc/hosts
127.0.0.1 openwook.local
```

## 架构说明

```
用户请求
    ↓
Caddy (端口 80/443)
    ├── 静态文件 → 直接响应 (public/)
    ├── API 请求 → 添加 CORS 头
    └── 其他请求 → 反向代理 + 轮询负载均衡
            ↓
    Next.js (端口 3000 / 3001 / 3002 / 3003)
            ↓
    PostgreSQL (端口 5432)
```

## 性能优化

### 1. 静态文件缓存

```caddy
header Cache-Control "public, max-age=31536000, immutable"
```

### 2. 压缩

```caddy
encode zstd gzip
```

### 3. 连接池

Next.js 会自动复用数据库连接 (pg Pool)。

多实例部署时要按实例数计算数据库连接上限：

```text
总连接上限 ≈ Next.js 实例数 × POSTGRES_POOL_MAX
```

例如 4 个实例且 `POSTGRES_POOL_MAX=8` 时，应用侧最多可能占用约 32 条 PostgreSQL 连接。压测发现数据库排队或连接耗尽时，优先调整 `POSTGRES_POOL_MAX`、优化慢查询或在应用与 PostgreSQL 之间增加 PgBouncer。

### 4. 多 upstream 负载均衡

`Caddyfile.openwook` 已配置 4 个本地 upstream：

```caddy
reverse_proxy 127.0.0.1:3000 127.0.0.1:3001 127.0.0.1:3002 127.0.0.1:3003 {
    lb_policy round_robin
    health_uri /api/health/ready
}
```

含义：

- `round_robin`：请求按顺序分配给多个 Next.js 实例，避免单个 Node.js 进程吃满 CPU。
- `health_uri /api/health/ready`：Caddy 定期探活，异常实例会被临时摘除。
- `fail_duration` / `max_fails`：短时间失败过多的 upstream 会被熔断一段时间，减少请求打到故障实例。

## 故障排除

### 端口权限问题

```bash
# 允许非 root 绑定 80/443
sudo setcap cap_net_bind_service=+ep /usr/bin/caddy
```

### Caddy 无法连接 Next.js

```bash
# 检查 Next.js 是否以生产模式运行在 3000-3003 端口
lsof -i :3000 -i :3001 -i :3002 -i :3003
ps -fp $(lsof -ti :3000 -ti :3001 -ti :3002 -ti :3003)

# 线上 HTML 不应包含 HMR/development 资源
curl -fsSL https://openwook.cloud/ | grep -E 'webpack-hmr|/_next/static/development' && echo 'ERROR: still running next dev' || echo 'OK: no HMR artifacts' 

# 检查 Caddy 配置
caddy validate --config /etc/caddy/Caddyfile.openwook
```

### 查看详细日志

```bash
# Caddy 访问日志
tail -f /var/log/caddy/openwook-access.log

# Caddy 运行日志
tail -f /var/log/caddy/caddy.out
```

## 与 next.config.ts 的协作

Caddy 和 Next.js 配置互补：

- **Next.js** 处理应用层 CORS (`/api/*`)
- **Caddy** 处理网络层代理、SSL、压缩、静态文件
- **环境变量** `NEXT_PUBLIC_APP_URL` 影响 Next.js 生成的绝对 URL

生产环境建议：
```env
NEXT_PUBLIC_APP_URL=https://openwook.cloud
NODE_ENV=production
OPENWOOK_HOST=127.0.0.1
```

生产进程应通过 `pnpm start` / `next start` 启动；`pnpm dev` 只用于本地开发。

## 安全建议

1. **生产环境务必使用 HTTPS**
2. **限制 API CORS** 为特定域名，不要使用 `*`
3. **启用 HSTS** (已在生产配置中包含)
4. **定期更新 Caddy** 获取安全补丁
5. **配置防火墙** 只开放 80/443，关闭 3000-3003

```bash
# UFW 示例
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 3000:3003/tcp
```
