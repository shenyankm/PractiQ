import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('deployment hardening', () => {
  it('forwards canonical host and protocol headers from Caddy to Next', () => {
    const caddyfile = readFileSync('Caddyfile.openwook', 'utf8');

    expect(caddyfile).toContain('header_up X-Forwarded-For {remote_host}');
    expect(caddyfile).toContain('header_up X-Forwarded-Host {host}');
    expect(caddyfile).toContain('header_up X-Forwarded-Proto {scheme}');
  });

  it('does not return internal health check error messages to clients', () => {
    const source = readFileSync('app/api/health/route.ts', 'utf8');

    expect(source).not.toMatch(/\berror:\s*error\b/);
    expect(source).not.toContain('error.message');
  });
});
