# OpenWook IP + SSL 部署指南

## 概述

本配置方案让你在**没有域名的情况下**，通过公网IP（`122.51.255.108`）安全访问 OpenWook 应用，并为未来添加域名和 Let's Encrypt 证书做好准备。

---

## 重要说明

### Let's Encrypt 不支持纯IP地址

**Let's Encrypt（以及大部分免费CA）不支持为纯IP地址签发SSL证书。** 因此：

| 访问方式 | 证书类型 | 浏览器警告 | 推荐度 |
|---|---|---|---|
| IP地址 + `tls internal` | Caddy自签名证书 | 有（可继续访问） | 临时方案 |
| IP地址 + ZeroSSL | ZeroSSL IP证书 | 无 | 需要EAB配置 |
| 域名 + Let's Encrypt | 自动申请免费证书 | 无 | 推荐方案 |

---

## 快速部署

### 1. 前置条件

```bash
# 确保 Caddy 已安装
caddy version

# 确保 Next.js 应用已构建
pnpm build

# 确保日志目录存在且有权限
sudo mkdir -p /var/log/caddy
sudo chown -R $(whoami):$(whoami) /var/log/caddy
```

### 2. 防火墙配置

**关键：只开放 80/443，关闭 3000 端口！**

```bash
# UFW (Ubuntu)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 3000/tcp
sudo ufw reload

# 验证
sudo ufw status
```

云服务器还需要在**安全组/防火墙**中开放：
- TCP 80（HTTP）
- TCP 443（HTTPS）
- 关闭 TCP 3000（不要暴露Next.js直连端口）

### 3. 启动 Next.js 应用

```bash
# 生产模式启动
export NODE_ENV=production
export PORT=3000
pnpm start

# 或使用 PM2 守护进程
pm2 start pnpm --name openwook -- start
pm2 save
pm2 startup
```

### 4. 启动 Caddy

```bash
# 使用新的IP配置文件
export OPENWOOK_ROOT=/home/ubuntu/projects/openwook
caddy run --config /etc/caddy/Caddyfile.ip --adapter caddyfile

# 或使用管理脚本（见下方）
./caddy-manage-ip.sh start
```

### 5. 访问应用

- **HTTP**: http://122.51.255.108（会自动重定向到HTTPS）
- **HTTPS**: https://122.51.255.108

> 使用HTTPS访问时，浏览器会显示「不安全」警告，因为使用的是Caddy内部自签名证书。点击「高级」→「继续前往」即可。

---

## 配置文件说明

### `Caddyfile.ip` 结构

```
全局配置
├── auto_https off          # 关闭自动HTTPS（我们手动控制）
├── admin off               # 关闭管理接口
└── email                   # ACME账户邮箱

IP:443 (HTTPS)
├── tls internal            # 使用自签名证书
├── 安全头                  # HSTS, CSP, XSS等
├── API CORS               # 跨域配置
├── 静态文件缓存           # public/ 目录直接服务
├── Next.js 资源缓存       # /_next/* 长期缓存
└── 反向代理 → :3000       # 主应用

IP:80 (HTTP)
└── 重定向到 HTTPS         # 强制HTTPS

域名占位（已注释）
└── 添加域名后取消注释，自动Let's Encrypt
```

---

## 进阶配置

### 方案A：ZeroSSL IP证书（推荐用于IP访问）

ZeroSSL支持为IP地址签发证书。需要在 [zerossl.com](https://zerossl.com) 注册并获取 EAB (External Account Binding) 凭据。

```caddyfile
122.51.255.108:443 {
    tls {
        ca https://acme.zerossl.com/v2/DV90
        eab {
            key_id "YOUR_EAB_KEY_ID"
            mac_key "YOUR_EAB_HMAC_KEY"
        }
    }
    ...
}
```

### 方案B：自签名证书（手动管理）

如果你有现成的证书文件：

```caddyfile
122.51.255.108:443 {
    tls /path/to/cert.pem /path/to/key.pem
    ...
}
```

### 方案C：添加域名后自动Let's Encrypt

1. 购买/注册域名（如 `openwook.com`）
2. 添加A记录指向 `122.51.255.108`
3. 修改 `/etc/caddy/Caddyfile.ip`，取消注释域名配置块
4. 重启 Caddy

```caddyfile
openwook.com:443 {
    tls admin@openwook.com    # 自动申请Let's Encrypt
    ...
}
```

Caddy会自动完成：
- 证书申请
- 证书续期（每60天）
- OCSP装订
- HTTP/2 + HTTP/3 支持

---

## 管理脚本

创建 `caddy-manage-ip.sh`：

```bash
#!/bin/bash
set -e

CADDYFILE="/etc/caddy/Caddyfile.ip"
CADDY_PID_FILE="/tmp/caddy-openwook-ip.pid"
LOG_DIR="/var/log/caddy"
OPENWOOK_ROOT="/home/ubuntu/projects/openwook"

start() {
    if [ -f "$CADDY_PID_FILE" ] && kill -0 "$(cat $CADDY_PID_FILE)" 2>/dev/null; then
        echo "Caddy 已在运行 (PID: $(cat $CADDY_PID_FILE))"
        return
    fi
    
    echo "启动 Caddy (IP模式)..."
    export OPENWOOK_ROOT="$OPENWOOK_ROOT"
    nohup caddy run --config "$CADDYFILE" --adapter caddyfile > "$LOG_DIR/caddy.out" 2>&1 &
    echo $! > "$CADDY_PID_FILE"
    sleep 2
    
    if kill -0 "$(cat $CADDY_PID_FILE)" 2>/dev/null; then
        echo "Caddy 启动成功"
        echo "HTTP:  http://122.51.255.108"
        echo "HTTPS: https://122.51.255.108"
    else
        echo "启动失败，查看日志: $LOG_DIR/caddy.out"
        rm -f "$CADDY_PID_FILE"
        exit 1
    fi
}

# ... 其他命令与 caddy-manage.sh 相同
```

---

## 常见问题

### Q: 浏览器显示「不安全」怎么办？

A: 这是正常的，因为IP地址使用的是Caddy自签名证书。点击「高级」→「继续前往」即可。添加域名后会自动消除。

### Q: 如何信任自签名证书？

A: 可以导出Caddy的内部CA根证书并导入到系统/浏览器信任库：

```bash
# 查找Caddy的本地CA证书
cat ~/.local/share/caddy/pki/authorities/local/root.crt

# 或查看Caddy文档了解如何导出
```

### Q: Let's Encrypt 真的不能给IP发证书吗？

A: 是的。Let's Encrypt的Baseline Requirements明确规定证书必须绑定域名。目前只有部分商业CA（如DigiCert、Sectigo）和ZeroSSL支持IP证书。

### Q: 可以同时监听IP和域名吗？

A: 可以。`Caddyfile.ip` 已经预留了域名配置块，取消注释即可同时服务IP和域名。

### Q: 需要备案吗？

A: 如果你在中国境内提供服务，使用域名需要ICP备案。纯IP访问不需要域名备案，但仍需遵守相关法规。

---

## 安全建议

1. **尽快添加域名**：IP访问仅作为过渡方案
2. **配置防火墙**：仅开放80/443，关闭3000
3. **启用自动更新**：`sudo apt install unattended-upgrades`
4. **配置fail2ban**：防止暴力攻击
5. **定期备份**：证书和数据

---

## 架构

```
用户浏览器
    ↓ https://122.51.255.108
Caddy (443端口)
    ├── 静态文件 → 直接响应
    ├── API请求 → 添加CORS头
    └── 其他请求 → 反向代理
            ↓
    Next.js (3000端口, localhost only)
            ↓
    PostgreSQL (5432端口, localhost only)
```
