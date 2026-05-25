import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('API route structure', () => {
  it('keeps auth and billing endpoints out of the catch-all route', () => {
    const expectedRoutes = [
      'app/api/v1/auth/me/route.ts',
      'app/api/v1/auth/register/route.ts',
      'app/api/v1/auth/login/route.ts',
      'app/api/v1/auth/logout/route.ts',
      'app/api/v1/billing/alipay/checkout/route.ts',
      'app/api/v1/billing/alipay/notify/route.ts',
      'app/api/v1/billing/alipay/return/route.ts',
      'app/api/v1/billing/alipay/summary/route.ts'
    ];

    expect(expectedRoutes.filter((route) => !existsSync(route))).toEqual([]);

    const catchAll = readFileSync('app/api/v1/[[...path]]/route.ts', 'utf8');
    expect(catchAll).not.toContain('auth/register');
    expect(catchAll).not.toContain('auth/login');
    expect(catchAll).not.toContain('auth/logout');
    expect(catchAll).not.toContain('auth/me');
    expect(catchAll).not.toContain('billing/alipay');
  });
});
