# Caddy 服务器配置指南

OpenWook 使用 Caddy 在单机上终止 HTTPS、服务静态资源，并把动态请求轮询代理到多个本地 Next.js 生产实例。

## 当前生产架构

```text
用户请求
    ↓
Caddy :80/:443
    ├── www.openwook.cloud → 301/308 到 openwook.cloud
    ├── /images、/fonts、favicon、robots、sitemap → public/ 直出
    ├── /api/* → CORS + 反向代理
    ├── /_next/static/* → 反向代理 + immutable 缓存
    └── 其他路径 → 反向代理
            ↓ round_robin + health check
Next.js 127.0.0.1:3000 / 3001 / 3002 / 3003
            ↓
PostgreSQL / Redis
```

`Caddyfile.openwook` 是当前生产域名配置：

- `openwook.cloud`：HTTPS canonical 站点。
- `www.openwook.cloud`：永久重定向到 `openwook.cloud`。
- Caddy 自动管理 TLS；80 端口只用于自动 HTTP → HTTPS 跳转。
- 本地 Next.js 进程只监听 `127.0.0.1`，不要直接暴露 3000-3003。

## 文件说明

| 文件 | 用途 |
|------|------|
| `Caddyfile.openwook` | 生产 Caddy 配置，部署到 `/etc/caddy/Caddyfile.openwook` |
| `caddy-openwook.service` | Caddy systemd 服务模板 |
| `openwook@.service` | 推荐的 Next.js 多实例 systemd 模板，实例名就是端口 |
| `openwook.service` | 单实例兼容 unit；多实例生产模式不要与 `openwook@3000` 同时启用 |
| `openwook-import-worker.service` | 后台导入 worker 服务 |
| `scripts/deploy/openwook-systemd.sh` | 构建、安装 systemd/Caddy 配置、启动多实例 |
| `scripts/deploy/check-openwook-caddy.sh` | 只读验证 Caddy、upstream、健康检查和服务状态 |
| `caddy-manage.sh` | 手动启动/重载/验证 Caddy 的本机管理脚本 |

## 安装与启动

### 1. 安装 Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
caddy version
```

### 2. 构建生产包

```bash
pnpm install
pnpm build
```

生产环境不要把公开域名代理到 `pnpm dev` / `next dev`，否则浏览器会加载 HMR 资源并持续尝试连接 `/_next/webpack-hmr`。

### 3. 推荐：多实例 systemd 部署

多实例生产模式统一使用 `openwook@.service`，不要再启用 `openwook.service` 承载 3000 端口。

```bash
sudo OPENWOOK_PORTS=3000,3001,3002,3003 scripts/deploy/openwook-systemd.sh
```

该脚本会：

1. 构建生产包。
2. 安装 `openwook@.service`、`openwook-import-worker.service`、`caddy-openwook.service` 和 `Caddyfile.openwook`。
3. 校验 `OPENWOOK_PORTS` 与 `Caddyfile.openwook` 的 upstream 端口一致。
4. 停用兼容单实例 `openwook.service`，避免与 `openwook@3000` 抢占端口。
5. 启用并启动 `openwook@3000`、`openwook@3001`、`openwook@3002`、`openwook@3003`、导入 worker 和 Caddy。
6. Caddy 已运行时执行 reload，失败再 restart。

手动部署等价命令：

```bash
sudo cp Caddyfile.openwook /etc/caddy/Caddyfile.openwook
sudo cp openwook@.service openwook-import-worker.service caddy-openwook.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl disable --now openwook.service || true
sudo systemctl enable --now openwook@3000 openwook@3001 openwook@3002 openwook@3003
sudo systemctl enable --now openwook-import-worker.service caddy-openwook.service
sudo systemctl reload caddy-openwook || sudo systemctl restart caddy-openwook
```

### 4. 单实例兼容模式

仅在低流量或排障时使用 `openwook.service`：

```bash
sudo cp openwook.service caddy-openwook.service /etc/systemd/system/
sudo cp Caddyfile.openwook /etc/caddy/Caddyfile.openwook
sudo systemctl daemon-reload
sudo systemctl enable --now openwook.service caddy-openwook.service
```

注意：当前 `Caddyfile.openwook` 仍写有 4 个 upstream；如果只运行 3000，Caddy 会把 3001-3003 判为不健康并只使用 3000。长期生产不建议这样运行。

## Caddy 负载均衡配置

核心配置位于 `Caddyfile.openwook` 的 `openwook_next_upstreams` snippet：

```caddy
reverse_proxy 127.0.0.1:3000 127.0.0.1:3001 127.0.0.1:3002 127.0.0.1:3003 {
    lb_policy round_robin
    lb_try_duration 5s
    lb_try_interval 250ms
    fail_duration 30s
    max_fails 3
    health_uri /api/health/ready
    health_interval 10s
    health_timeout 2s
    health_status 200
}
```

含义：

- `round_robin`：按顺序把请求分发到 4 个 Next.js 实例，避免单个 Node.js 进程吃满 CPU。
- `health_uri /api/health/ready`：Caddy 每 10 秒主动探测 readiness。
- `health_timeout 2s` + `health_status 200`：探测 2 秒内返回 200 才算健康。
- `fail_duration 30s` + `max_fails 3`：短时间失败过多的 upstream 会被临时熔断。
- `lb_try_duration 5s` + `lb_try_interval 250ms`：请求失败时，在 5 秒窗口内按 250ms 间隔尝试其它 upstream。

`/api/health/ready` 会检查 PostgreSQL `SELECT 1` 和 Redis ping。共享依赖故障时，所有 Next.js 实例可能同时不健康；负载均衡无法绕过数据库或 Redis 的全局故障，需要依赖数据库/Redis 高可用、连接预算和告警。

> 当前 snippet 会在 API、`/_next/static` 和默认动态路由中重复 import。Caddy 配置有效，但可能为同一组 upstream 创建多套健康检查器。v1 保留该结构以避免改变缓存和路由语义；如果后续要减少重复探活，应先用访问日志和 Caddy debug 日志确认行为。

## 性能与连接池容量

### Caddy 层

- `encode zstd gzip`：启用压缩。
- `/_next/static/*`：`Cache-Control: public, max-age=31536000, immutable`。
- `/images/*`、`/fonts/*`、`favicon.ico`、`robots.txt`、`sitemap.xml`：由 Caddy 从 `public/` 直出，缓存 1 天。
- 访问日志写入 `/var/log/caddy/openwook-access.log`，10MB 轮转，保留 30 个文件或 720 小时。

### 数据库连接池

应用使用 `postgres` 客户端池，默认：

```text
POSTGRES_POOL_MAX = 8    # systemd Web 实例默认值
POSTGRES_IDLE_TIMEOUT_SECONDS = 30
POSTGRES_CONNECT_TIMEOUT_SECONDS = 10
```

容量估算：

```text
Web 最大连接数    = Web 实例数 × POSTGRES_POOL_MAX
Worker 最大连接数 = Worker 数 × Worker POSTGRES_POOL_MAX
当前推荐预算      = 4 × 8 + 1 × 4 = 36 条应用侧 PostgreSQL 连接
```

如果 PostgreSQL `max_connections` 较低，或者压测中出现连接排队、readiness 超时、慢查询积压，优先把 Web `POSTGRES_POOL_MAX` 调到 `5..6`，再考虑优化慢查询或在应用与 PostgreSQL 之间加入 PgBouncer。

Redis cache/queue 连接也会按实例数增长；当前配置使用短连接超时和有限重试，暂不引入新连接池组件。

## 验证流程

### 1. 只读一键检查

```bash
scripts/deploy/check-openwook-caddy.sh
```

可选参数：

```bash
OPENWOOK_PORTS=3000,3001,3002,3003 \
OPENWOOK_DOMAIN=openwook.cloud \
OPENWOOK_ROOT=/home/ubuntu/projects/openwook \
scripts/deploy/check-openwook-caddy.sh
```

### 部署输入 dry-run

在不构建、不安装 systemd、不启动服务的情况下，只校验端口参数与 Caddy upstream 是否一致：

```bash
OPENWOOK_RUN_BUILD=0 OPENWOOK_INSTALL_SYSTEMD=0 OPENWOOK_START_SERVICES=0 \
OPENWOOK_PORTS=3000,3001,3002,3003 \
scripts/deploy/openwook-systemd.sh
```

### 2. Caddy 配置验证

```bash
OPENWOOK_ROOT=/home/ubuntu/projects/openwook \
caddy validate --config Caddyfile.openwook --adapter caddyfile
```

部署到 `/etc/caddy` 后：

```bash
sudo OPENWOOK_ROOT=/home/ubuntu/projects/openwook \
caddy validate --config /etc/caddy/Caddyfile.openwook --adapter caddyfile
```

### 3. systemd 状态

```bash
systemctl is-active caddy-openwook
systemctl is-active openwook@3000 openwook@3001 openwook@3002 openwook@3003
systemctl is-active openwook.service || true
```

多实例生产模式下，`openwook@3000-3003` 应为 active，`openwook.service` 应为 inactive。

### 4. upstream readiness

```bash
for p in 3000 3001 3002 3003; do
  curl -fsS "http://127.0.0.1:$p/api/health/ready"
  echo
done
```

### 5. 经 Caddy 验证 HTTPS 与跳转

本地验证生产域名配置时必须带 SNI：

```bash
curl -k --resolve openwook.cloud:443:127.0.0.1 \
  https://openwook.cloud/api/health/ready

curl -I --resolve openwook.cloud:80:127.0.0.1 \
  http://openwook.cloud/api/health/ready
```

期望：HTTPS 返回 200；HTTP 返回 308/301 到 HTTPS。

## 常用操作

```bash
# 查看 Caddy 日志
sudo journalctl -u caddy-openwook -f
sudo tail -f /var/log/caddy/openwook-access.log

# 查看 Next.js 实例日志
sudo journalctl -u openwook@3000 -u openwook@3001 -u openwook@3002 -u openwook@3003 -f

# 平滑重载 Caddy
sudo systemctl reload caddy-openwook

# 重新部署 4 个实例
sudo OPENWOOK_PORTS=3000,3001,3002,3003 scripts/deploy/openwook-systemd.sh
```

## 故障排除

### Caddy 无法连接 upstream

```bash
ss -ltnp | grep -E ':(3000|3001|3002|3003)\b'
for p in 3000 3001 3002 3003; do curl -fsS "http://127.0.0.1:$p/api/health/ready" || echo "port $p failed"; done
```

如果某个端口未监听：

```bash
sudo systemctl status openwook@PORT
sudo journalctl -u openwook@PORT -n 100 --no-pager
```

### 配置端口不一致

`OPENWOOK_PORTS` 必须与 `Caddyfile.openwook` 的 upstream 列表一致。变更实例数时同时更新：

1. `Caddyfile.openwook` 的 `reverse_proxy 127.0.0.1:...` 列表。
2. 部署命令中的 `OPENWOOK_PORTS`。
3. 连接池容量预算。

### 线上 HTML 出现 dev/HMR 资源

```bash
curl -fsSL https://openwook.cloud/ | grep -E 'webpack-hmr|/_next/static/development' \
  && echo 'ERROR: still running next dev' \
  || echo 'OK: no HMR artifacts'
```

出现 ERROR 时，确认 systemd 使用的是 `pnpm start:prod`，而不是 `pnpm dev`。

## 安全建议

1. 生产环境只开放 80/443，禁止公网访问 3000-3003。
2. API CORS 限制为 `https://openwook.cloud`。
3. HSTS、安全响应头和 HTTPS 自动证书保持开启。
4. 定期更新 Caddy 与 Node.js 运行时。
5. `.env.local` 只保留在服务器，不提交仓库。

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 3000:3003/tcp
```
