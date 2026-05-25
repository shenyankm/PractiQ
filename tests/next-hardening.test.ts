import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import nextConfig from '@/next.config';

describe('Next.js hardening', () => {
  it('keeps PPR incremental so routes opt in explicitly', () => {
    expect(nextConfig.experimental?.ppr).toBe('incremental');
  });

  it('uses the proxy file convention instead of deprecated middleware', () => {
    expect(existsSync('proxy.ts')).toBe(true);
    expect(existsSync('middleware.ts')).toBe(false);
  });

  it('serves an explicit robots.txt for production crawlers', () => {
    const robots = readFileSync('public/robots.txt', 'utf8');

    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Disallow:');
  });
});
