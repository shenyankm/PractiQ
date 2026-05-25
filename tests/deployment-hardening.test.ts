import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('deployment hardening', () => {
  it('forwards canonical host and protocol headers from Caddy to Next', () => {
    const caddyfile = readFileSync('Caddyfile.openwook', 'utf8');

    expect(caddyfile).toContain('header_up X-Forwarded-For {remote_host}');
    expect(caddyfile).toContain('header_up X-Forwarded-Host {host}');
    expect(caddyfile).toContain('header_up X-Forwarded-Proto {scheme}');
  });


  it('provides a production Next.js systemd service instead of serving dev HMR on the public domain', () => {
    const service = readFileSync('openwook.service', 'utf8');
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

    expect(service).toContain('Environment=NODE_ENV=production');
    expect(service).toMatch(/Environment=PATH=.*\/bin/);
    expect(service).toContain('ExecStart=/usr/bin/env pnpm start:prod');
    expect(packageJson.scripts['start:prod']).toBe('next start --hostname 127.0.0.1 --port 3000');
    expect(service).not.toContain('pnpm dev');
    expect(service).not.toContain('next dev');
  });

  it('does not return internal health check error messages to clients', () => {
    const source = readFileSync('app/api/health/route.ts', 'utf8');

    expect(source).not.toMatch(/\berror:\s*error\b/);
    expect(source).not.toContain('error.message');
  });
});
