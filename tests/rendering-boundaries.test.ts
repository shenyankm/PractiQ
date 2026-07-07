import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('App Router rendering boundaries', () => {
  it('keeps authentication at the route-group boundary', () => {
    const layout = readFileSync('app/(openwook)/layout.tsx', 'utf8');

    expect(layout).toContain('getCurrentUser');
    expect(layout).toContain("redirect('/sign-in')");
  });

  it('provides explicit loading and error boundaries for authenticated routes', () => {
    expect(existsSync('app/(openwook)/loading.tsx')).toBe(true);
    expect(existsSync('app/(openwook)/error.tsx')).toBe(true);
  });

  it('uses aggregate service reads on data-dense detail pages', () => {
    const bankDetailPage = readFileSync('app/(openwook)/banks/[bankId]/page.tsx', 'utf8');
    const bankManagePage = readFileSync('app/(openwook)/banks/[bankId]/manage/page.tsx', 'utf8');
    const importDetailPage = readFileSync('app/(openwook)/imports/[jobId]/page.tsx', 'utf8');

    expect(bankDetailPage).toContain('getBankWithItems');
    expect(bankManagePage).toContain('getBankWithItems');
    expect(importDetailPage).toContain('getImportJobDetail');
    expect(importDetailPage).not.toContain('listImportJobChildren');
  });

  it('streams list-heavy authenticated pages behind Suspense boundaries', () => {
    const banksPage = readFileSync('app/(openwook)/banks/page.tsx', 'utf8');
    const importsPage = readFileSync('app/(openwook)/imports/page.tsx', 'utf8');

    expect(banksPage).toContain('<Suspense fallback=');
    expect(importsPage).toContain('<Suspense fallback=');
  });
});
