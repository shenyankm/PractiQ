import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import nextConfig from '@/next.config';
import { config as proxyConfig } from '@/proxy';

describe('Next.js hardening', () => {
  it('keeps PPR incremental so routes opt in explicitly', () => {
    expect(nextConfig.experimental?.ppr).toBe('incremental');
  });

  it('uses the proxy file convention instead of deprecated middleware', () => {
    expect(existsSync('proxy.ts')).toBe(true);
    expect(existsSync('middleware.ts')).toBe(false);
  });

  it('keeps proxy off Next internals and public metadata files', () => {
    const matcher = proxyConfig.matcher.join('|');

    expect(matcher).toContain('_next/data');
    expect(matcher).toContain('_next/static');
    expect(matcher).toContain('_next/image');
    expect(matcher).toContain('robots.txt');
    expect(matcher).toContain('sitemap.xml');
  });

  it('serves an explicit robots.txt for production crawlers', () => {
    const robots = readFileSync('public/robots.txt', 'utf8');

    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Disallow:');
  });
});
