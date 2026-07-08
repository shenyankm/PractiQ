import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('admin management pages', () => {
  it('provides admin overview, user management, and knowledge point pages', () => {
    expect(existsSync('app/(openwook)/admin/page.tsx')).toBe(true);
    expect(existsSync('app/(openwook)/admin/users/page.tsx')).toBe(true);
    expect(existsSync('app/(openwook)/admin/knowledge-points/page.tsx')).toBe(true);
  });

  it('protects admin pages with role checks', () => {
    const overview = readFileSync('app/(openwook)/admin/page.tsx', 'utf8');
    const users = readFileSync('app/(openwook)/admin/users/page.tsx', 'utf8');
    const knowledgePoints = readFileSync('app/(openwook)/admin/knowledge-points/page.tsx', 'utf8');

    expect(overview).toContain('requireAdminPage');
    expect(users).toContain('requireAdminPage');
    expect(knowledgePoints).toContain('requireAdminPage');
  });


  it('lets administrators manage user status, role, and membership from the users page', () => {
    const users = readFileSync('app/(openwook)/admin/users/page.tsx', 'utf8');

    expect(users).toContain('setUserStatusAction');
    expect(users).toContain('updateUserAccessAction');
    expect(users).toContain('name="role"');
    expect(users).toContain('name="membership"');
  });
});
