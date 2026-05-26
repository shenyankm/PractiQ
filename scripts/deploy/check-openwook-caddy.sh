#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${OPENWOOK_ROOT:-/home/ubuntu/projects/openwook}"
PORTS_CSV="${OPENWOOK_PORTS:-3000,3001,3002,3003}"
DOMAIN="${OPENWOOK_DOMAIN:-openwook.cloud}"
CADDY_CONFIG="${OPENWOOK_CADDY_CONFIG:-/etc/caddy/Caddyfile.openwook}"
CADDY_SERVICE="${OPENWOOK_CADDY_SERVICE:-caddy-openwook}"
TIMEOUT="${OPENWOOK_CHECK_TIMEOUT:-5}"

IFS=',' read -r -a PORTS <<< "$PORTS_CSV"

failures=0

section() {
  printf '\n== %s ==\n' "$1"
}

check() {
  local description="$1"
  shift
  if "$@"; then
    printf 'OK   %s\n' "$description"
  else
    printf 'FAIL %s\n' "$description" >&2
    failures=$((failures + 1))
  fi
}

trim_port() {
  local port="$1"
  port="${port//[[:space:]]/}"
  printf '%s' "$port"
}

section "Caddy config"
check "repo Caddyfile exists" test -f "$ROOT_DIR/Caddyfile.openwook"
check "installed Caddyfile exists" test -f "$CADDY_CONFIG"
if [ -f "$ROOT_DIR/Caddyfile.openwook" ] && [ -f "$CADDY_CONFIG" ]; then
  check "installed Caddyfile matches repo" cmp -s "$ROOT_DIR/Caddyfile.openwook" "$CADDY_CONFIG"
fi
check "Caddyfile validates" env OPENWOOK_ROOT="$ROOT_DIR" caddy validate --config "$CADDY_CONFIG" --adapter caddyfile >/tmp/openwook-caddy-validate.log 2>&1

section "systemd services"
check "$CADDY_SERVICE is active" systemctl is-active --quiet "$CADDY_SERVICE"
if systemctl list-unit-files openwook.service >/dev/null 2>&1; then
  if systemctl is-active --quiet openwook.service; then
    printf 'WARN openwook.service is active; multi-instance mode should use openwook@3000 instead\n' >&2
  else
    printf 'OK   openwook.service is inactive\n'
  fi
fi
for raw_port in "${PORTS[@]}"; do
  port="$(trim_port "$raw_port")"
  [ -n "$port" ] || continue
  check "openwook@$port is active" systemctl is-active --quiet "openwook@$port"
done

section "listeners"
check "Caddy listens on :80" bash -c "ss -ltn 2>/dev/null | grep -Eq '[:.]80[[:space:]]'"
check "Caddy listens on :443" bash -c "ss -ltn 2>/dev/null | grep -Eq '[:.]443[[:space:]]'"
for raw_port in "${PORTS[@]}"; do
  port="$(trim_port "$raw_port")"
  [ -n "$port" ] || continue
  check "Next.js listens on 127.0.0.1:$port" bash -c "ss -ltn 2>/dev/null | grep -Eq '127\\.0\\.0\\.1:$port[[:space:]]'"
done

section "upstream readiness"
for raw_port in "${PORTS[@]}"; do
  port="$(trim_port "$raw_port")"
  [ -n "$port" ] || continue
  check "http://127.0.0.1:$port/api/health/ready returns 200" curl -fsS --max-time "$TIMEOUT" "http://127.0.0.1:$port/api/health/ready" -o /tmp/openwook-health-"$port".json
done

section "Caddy entrypoint"
check "https://$DOMAIN/api/health/ready via local Caddy returns 200" curl -k -fsS --max-time "$TIMEOUT" --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health/ready" -o /tmp/openwook-caddy-health.json
http_status="$(curl -sS --max-time "$TIMEOUT" --resolve "$DOMAIN:80:127.0.0.1" -o /tmp/openwook-caddy-http.body -w '%{http_code}' "http://$DOMAIN/api/health/ready" || true)"
if [ "$http_status" = "301" ] || [ "$http_status" = "308" ]; then
  printf 'OK   http://%s redirects to HTTPS (%s)\n' "$DOMAIN" "$http_status"
else
  printf 'FAIL http://%s expected 301/308, got %s\n' "$DOMAIN" "${http_status:-curl-error}" >&2
  failures=$((failures + 1))
fi

if [ "$failures" -eq 0 ]; then
  printf '\nAll OpenWook Caddy checks passed.\n'
else
  printf '\n%s OpenWook Caddy check(s) failed.\n' "$failures" >&2
  printf 'Caddy validate log: /tmp/openwook-caddy-validate.log\n' >&2
  exit 1
fi
