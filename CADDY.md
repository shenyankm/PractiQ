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

```bash
# 开发模式
pnpm dev

# 生产模式
pnpm build
pnpm start
```

确保应用运行在 `localhost:3000`。

### 3. 启动 Caddy

```bash
# 使用管理脚本
./caddy-manage.sh start

# 或直接运行
export OPENWOOK_ROOT=/home/ubuntu/projects/openwook
caddy run --config Caddyfile --adapter caddyfile
```

访问 `http://localhost` 即可通过 Caddy 访问应用。

## 文件说明

| 文件 | 用途 |
|------|------|
| `Caddyfile` | 开发环境配置 (HTTP) |
| `Caddyfile.prod` | 生产环境配置 (HTTPS) |
| `caddy-manage.sh` | 服务管理脚本 |
| `caddy-openwook.service` | systemd 服务配置 |

## 配置详解

### 开发配置 (`Caddyfile`)

- **端口**: 80
- **协议**: HTTP
- **代理目标**: localhost:3000
- **CORS**: 全开放 (`*`)
- **静态文件**: 直接从 `public/` 目录提供
- **缓存**: Next.js 静态资源长期缓存

### 生产配置 (`Caddyfile.prod`)

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
# 复制服务文件
sudo cp caddy-openwook.service /etc/systemd/system/

# 重新加载 systemd
sudo systemctl daemon-reload

# 启动服务
sudo systemctl start caddy-openwook

# 开机自启
sudo systemctl enable caddy-openwook

# 查看状态
sudo systemctl status caddy-openwook

# 查看日志
sudo journalctl -u caddy-openwook -f
```

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
    └── 其他请求 → 反向代理
            ↓
    Next.js (端口 3000)
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

## 故障排除

### 端口权限问题

```bash
# 允许非 root 绑定 80/443
sudo setcap cap_net_bind_service=+ep /usr/bin/caddy
```

### Caddy 无法连接 Next.js

```bash
# 检查 Next.js 是否运行在 3000 端口
lsof -i :3000

# 检查 Caddy 配置
caddy validate --config Caddyfile
```

### 查看详细日志

```bash
# Caddy 访问日志
tail -f /var/log/caddy/access.log

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
NEXT_PUBLIC_APP_URL=https://yourdomain.com
```

## 安全建议

1. **生产环境务必使用 HTTPS**
2. **限制 API CORS** 为特定域名，不要使用 `*`
3. **启用 HSTS** (已在生产配置中包含)
4. **定期更新 Caddy** 获取安全补丁
5. **配置防火墙** 只开放 80/443，关闭 3000

```bash
# UFW 示例
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 3000/tcp
```
