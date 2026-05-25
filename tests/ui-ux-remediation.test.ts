import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('UI/UX remediation guardrails', () => {
  it('uses a Chinese document language and does not block user zoom', () => {
    const layout = readFileSync('app/layout.tsx', 'utf8');

    expect(layout).toContain('lang="zh-CN"');
    expect(layout).not.toContain('maximumScale');
  });

  it('keeps global theme tokens in one Tailwind v4 format', () => {
    const globals = readFileSync('app/globals.css', 'utf8');

    expect(globals.match(/@theme inline/g)?.length).toBe(1);
    expect(globals).not.toContain('hsl(var(--background))');
    expect(globals).not.toMatch(/--background:\s*0 0% 100%/);
  });

  it('installs the shadcn primitives needed for the redesigned flows', () => {
    for (const component of ['breadcrumb', 'empty', 'field', 'sonner', 'table', 'tabs', 'tooltip']) {
      expect(existsSync(`components/ui/${component}.tsx`), component).toBe(true);
    }
  });

  it('gives filter search fields accessible names instead of placeholder-only labels', () => {
    const banks = readFileSync('app/(openwook)/banks/page.tsx', 'utf8');
    const adminUsers = readFileSync('app/(openwook)/admin/users/page.tsx', 'utf8');
    const knowledgePoints = readFileSync('app/(openwook)/admin/knowledge-points/page.tsx', 'utf8');

    expect(banks).toContain('htmlFor="bank-search"');
    expect(adminUsers).toContain('htmlFor="admin-user-search"');
    expect(knowledgePoints).toContain('htmlFor="knowledge-point-search"');
  });

  it('protects high-impact actions with confirmation dialogs', () => {
    const practice = readFileSync('app/(openwook)/practice/[sessionId]/page.tsx', 'utf8');
    const users = readFileSync('app/(openwook)/admin/users/page.tsx', 'utf8');

    expect(practice).toContain('确认完成会话');
    expect(practice).toContain('确认放弃练习');
    expect(users).toContain('确认停用用户');
  });

  it('does not repopulate password fields after auth failures', () => {
    const login = readFileSync('app/(login)/login.tsx', 'utf8');

    expect(login).not.toContain('defaultValue={state.password}');
  });
});
