import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('API route structure', () => {
  it('keeps auth, billing, and public read endpoints out of the catch-all route', () => {
    const expectedRoutes = [
      'app/api/v1/auth/me/route.ts',
      'app/api/v1/auth/register/route.ts',
      'app/api/v1/auth/login/route.ts',
      'app/api/v1/auth/logout/route.ts',
      'app/api/v1/billing/checkout/route.ts',
      'app/api/v1/billing/summary/route.ts',
      'app/api/v1/billing/webhook/route.ts',
      'app/api/v1/subjects/route.ts',
      'app/api/v1/question-types/route.ts',
      'app/api/v1/knowledge-points/route.ts'
    ];

    expect(expectedRoutes.filter((route) => !existsSync(route))).toEqual([]);

    const catchAll = readFileSync('app/api/v1/[[...path]]/route.ts', 'utf8');
    expect(catchAll).not.toContain('auth/register');
    expect(catchAll).not.toContain('auth/login');
    expect(catchAll).not.toContain('auth/logout');
    expect(catchAll).not.toContain('auth/me');
    expect(catchAll).not.toContain('billing/checkout');
    expect(catchAll).not.toContain("parts[0] === 'subjects'");
    expect(catchAll).not.toContain("parts[0] === 'question-types'");
    expect(catchAll).not.toContain("parts[0] === 'knowledge-points'");
  });

  it('removes the legacy user route in favor of versioned endpoints', () => {
    expect(existsSync('app/api/user/route.ts')).toBe(false);
  });
});
