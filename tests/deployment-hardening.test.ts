import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('deployment hardening', () => {
  it('keeps only non-default proxy headers explicit in Caddy', () => {
    const caddyfile = readFileSync('Caddyfile.openwook', 'utf8');

    expect(caddyfile).toContain('header_up Host {host}');
    expect(caddyfile).toContain('header_up X-Real-IP {remote_host}');
    expect(caddyfile).not.toContain('header_up X-Forwarded-For {remote_host}');
    expect(caddyfile).not.toContain('header_up X-Forwarded-Host {host}');
    expect(caddyfile).not.toContain('header_up X-Forwarded-Proto {scheme}');
  });

  it('load balances Caddy traffic across multiple local Next.js upstreams', () => {
    const caddyfile = readFileSync('Caddyfile.openwook', 'utf8');

    expect(caddyfile).toMatch(/reverse_proxy\s+127\.0\.0\.1:3000\s+127\.0\.0\.1:3001\s+127\.0\.0\.1:3002\s+127\.0\.0\.1:3003\s+\{/);
    expect(caddyfile).toContain('lb_policy round_robin');
    expect(caddyfile).toContain('lb_try_duration 5s');
    expect(caddyfile).toContain('fail_duration 30s');
    expect(caddyfile).toContain('max_fails 3');
    expect(caddyfile).toContain('health_uri /api/health/ready');
    expect(caddyfile).toContain('health_status 200');
  });

  it('provides a production Next.js systemd service instead of serving dev HMR on the public domain', () => {
    const service = readFileSync('openwook.service', 'utf8');
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

    expect(service).toContain('Environment=NODE_ENV=production');
    expect(service).toContain('Environment=OPENWOOK_HOST=127.0.0.1');
    expect(service).toContain('Environment=POSTGRES_POOL_MAX=8');
    expect(service).toContain('Environment=UV_THREADPOOL_SIZE=16');
    expect(service).toMatch(/Environment=PATH=.*\/bin/);
    expect(service).toContain('ExecStart=/usr/bin/env NODE_ENV=production OPENWOOK_HOST=127.0.0.1 PORT=3000 pnpm start:prod');
    expect(packageJson.scripts['start:prod']).toBe('next start --hostname ${OPENWOOK_HOST:-127.0.0.1} --port ${PORT:-3000}');
    expect(service).not.toContain('pnpm dev');
    expect(service).not.toContain('next dev');
  });

  it('provides a systemd template for port-indexed Next.js instances', () => {
    expect(existsSync('openwook@.service')).toBe(true);

    const service = readFileSync('openwook@.service', 'utf8');

    expect(service).toContain('Description=OpenWook Next.js Application instance on port %i');
    expect(service).toContain('Environment=PORT=%i');
    expect(service).toContain('Environment=POSTGRES_POOL_MAX=8');
    expect(service).toContain('Environment=UV_THREADPOOL_SIZE=16');
    expect(service).toContain('ExecStart=/usr/bin/env NODE_ENV=production OPENWOOK_HOST=127.0.0.1 PORT=%i pnpm start:prod');
    expect(service).not.toContain('pnpm dev');
    expect(service).not.toContain('next dev');
  });

  it('documents and scripts multi-instance deployment with database pool guardrails', () => {
    expect(existsSync('scripts/deploy/openwook-systemd.sh')).toBe(true);
    expect(existsSync('scripts/perf/quick-regression.mjs')).toBe(true);

    const deployScript = readFileSync('scripts/deploy/openwook-systemd.sh', 'utf8');
    const envExample = readFileSync('.env.example', 'utf8');
    const readme = readFileSync('README.md', 'utf8');
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

    expect(deployScript).toContain('OPENWOOK_PORTS:-3000,3001,3002,3003');
    expect(deployScript).toContain('OPENWOOK_START_SERVICES:-1');
    expect(deployScript).toContain('OPENWOOK_PORTS must match Caddyfile.openwook upstream ports');
    expect(deployScript).toContain('systemctl disable --now openwook.service');
    expect(deployScript).toContain('openwook@$port');
    expect(envExample).toContain('POSTGRES_POOL_MAX=8');
    expect(readme).toContain('instances × POSTGRES_POOL_MAX');
    expect(packageJson.scripts['perf:quick']).toBe('node scripts/perf/quick-regression.mjs');
  });

  it('does not return internal health check error messages to clients', () => {
    const source = readFileSync('app/api/health/route.ts', 'utf8');

    expect(source).not.toMatch(/\berror:\s*error\b/);
    expect(source).not.toContain('error.message');
  });

  it('routes metrics and readiness checks through hardened observability endpoints', () => {
    expect(existsSync('app/api/metrics/route.ts')).toBe(true);
    expect(existsSync('app/api/health/live/route.ts')).toBe(true);
    expect(existsSync('app/api/health/ready/route.ts')).toBe(true);

    const metricsSource = readFileSync('app/api/metrics/route.ts', 'utf8');
    expect(metricsSource).toContain('METRICS_TOKEN');
    expect(metricsSource).toContain('registry.metrics');
  });
});
