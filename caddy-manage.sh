#!/bin/bash

# OpenWook Caddy 服务管理脚本
# 用法: ./caddy-manage.sh {start|stop|restart|status|reload|logs}

set -e

CADDYFILE="/home/ubuntu/projects/openwook/Caddyfile"
CADDY_PID_FILE="/tmp/caddy-openwook.pid"
LOG_DIR="/var/log/caddy"
OPENWOOK_ROOT="/home/ubuntu/projects/openwook"

# 确保日志目录存在
mkdir -p "$LOG_DIR"

# 检查 caddy 是否安装
check_caddy() {
    if ! command -v caddy &> /dev/null; then
        echo "错误: Caddy 未安装"
        echo "安装命令:"
        echo "  sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https"
        echo "  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"
        echo "  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list"
        echo "  sudo apt update && sudo apt install caddy"
        exit 1
    fi
}

# 启动 Caddy
start() {
    check_caddy
    
    if [ -f "$CADDY_PID_FILE" ] && kill -0 "$(cat $CADDY_PID_FILE)" 2>/dev/null; then
        echo "Caddy 已在运行 (PID: $(cat $CADDY_PID_FILE))"
        return
    fi
    
    echo "启动 Caddy..."
    export OPENWOOK_ROOT="$OPENWOOK_ROOT"
    nohup caddy run --config "$CADDYFILE" --adapter caddyfile > "$LOG_DIR/caddy.out" 2>&1 &
    echo $! > "$CADDY_PID_FILE"
    sleep 2
    
    if kill -0 "$(cat $CADDY_PID_FILE)" 2>/dev/null; then
        echo "Caddy 启动成功 (PID: $(cat $CADDY_PID_FILE))"
        echo "访问: http://localhost"
    else
        echo "Caddy 启动失败，查看日志: $LOG_DIR/caddy.out"
        rm -f "$CADDY_PID_FILE"
        exit 1
    fi
}

# 停止 Caddy
stop() {
    if [ -f "$CADDY_PID_FILE" ]; then
        PID=$(cat "$CADDY_PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "停止 Caddy (PID: $PID)..."
            kill "$PID"
            rm -f "$CADDY_PID_FILE"
            echo "Caddy 已停止"
        else
            echo "Caddy 未运行"
            rm -f "$CADDY_PID_FILE"
        fi
    else
        echo "Caddy 未运行"
    fi
}

# 查看状态
status() {
    if [ -f "$CADDY_PID_FILE" ] && kill -0 "$(cat $CADDY_PID_FILE)" 2>/dev/null; then
        echo "Caddy 运行中 (PID: $(cat $CADDY_PID_FILE))"
        echo "配置: $CADDYFILE"
        echo "访问: http://localhost"
        echo ""
        echo "最近日志:"
        tail -n 5 "$LOG_DIR/access.log" 2>/dev/null || echo "暂无访问日志"
    else
        echo "Caddy 未运行"
    fi
}

# 重载配置
reload() {
    check_caddy
    
    if [ -f "$CADDY_PID_FILE" ] && kill -0 "$(cat $CADDY_PID_FILE)" 2>/dev/null; then
        echo "重载 Caddy 配置..."
        export OPENWOOK_ROOT="$OPENWOOK_ROOT"
        caddy reload --config "$CADDYFILE" --adapter caddyfile
        echo "配置已重载"
    else
        echo "Caddy 未运行，使用 start 启动"
    fi
}

# 查看日志
logs() {
    echo "=== Caddy 访问日志 (按 Ctrl+C 退出) ==="
    tail -f "$LOG_DIR/access.log" 2>/dev/null || echo "日志文件不存在"
}

# 验证配置
validate() {
    check_caddy
    echo "验证 Caddyfile 配置..."
    export OPENWOOK_ROOT="$OPENWOOK_ROOT"
    caddy validate --config "$CADDYFILE" --adapter caddyfile
}

# 主命令
case "${1:-}" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        stop
        sleep 1
        start
        ;;
    status)
        status
        ;;
    reload)
        reload
        ;;
    logs)
        logs
        ;;
    validate)
        validate
        ;;
    *)
        echo "OpenWook Caddy 管理脚本"
        echo ""
        echo "用法: $0 {start|stop|restart|status|reload|logs|validate}"
        echo ""
        echo "命令:"
        echo "  start     启动 Caddy 代理服务"
        echo "  stop      停止 Caddy 代理服务"
        echo "  restart   重启 Caddy 代理服务"
        echo "  status    查看运行状态"
        echo "  reload    重载配置 (无需重启)"
        echo "  logs      查看访问日志"
        echo "  validate  验证配置文件"
        echo ""
        echo "前提条件:"
        echo "  1. Next.js 应用运行在 localhost:3000"
        echo "  2. Caddy 已安装"
        echo ""
        echo "安装 Caddy:"
        echo "  sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https"
        echo "  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"
        echo "  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list"
        echo "  sudo apt update && sudo apt install caddy"
        ;;
esac
