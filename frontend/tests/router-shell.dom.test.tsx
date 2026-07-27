// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const authState = vi.hoisted(() => ({
  user: null as null | {
    role: 'admin' | 'user';
  } | undefined
}));

function stubPage(label: string) {
  return function StubPage() {
    return <h1>{label}</h1>;
  };
}

vi.mock('@/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuth: () => authState.user
}));

vi.mock('@/lib/api', () => ({
  apiRequest: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@/pages/LoginPage', () => ({ default: stubPage('Login page') }));
vi.mock('@/pages/AdminPage', () => ({ default: stubPage('Admin page') }));
vi.mock('@/pages/AdminKnowledgePointsPage', () => ({ default: stubPage('Admin knowledge points page') }));
vi.mock('@/pages/AdminUsersPage', () => ({ default: stubPage('Admin users page') }));
vi.mock('@/pages/DashboardPage', () => ({ default: stubPage('学习概览') }));

import { AppRouter } from '@/routes';

const standardUser = {
  role: 'user' as const
};

const adminUser = {
  role: 'admin' as const
};

function renderAt(pathname: string) {
  window.history.replaceState({}, '', pathname);
  return render(<AppRouter />);
}

describe('Vite React router and shell', () => {
  beforeEach(() => {
    authState.user = null;
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    cleanup();
  });

  it('redirects / to /dashboard for signed-in users', async () => {
    authState.user = standardUser;

    renderAt('/');

    await screen.findByRole('heading', { name: '学习概览' });
    await waitFor(() => expect(window.location.pathname).toBe('/dashboard'));
  });

  it('waits for authentication before routing protected pages', () => {
    authState.user = undefined;

    renderAt('/dashboard');

    expect(screen.queryByRole('heading')).toBeNull();
    expect(window.location.pathname).toBe('/dashboard');
  });

  it('redirects unauthenticated protected routes to sign-in with the original path', async () => {
    renderAt('/imports');

    await screen.findByRole('heading', { name: 'Login page' });
    await waitFor(() => expect(window.location.pathname).toBe('/sign-in'));
    expect(new URLSearchParams(window.location.search).get('redirect')).toBe('/imports');
  });

  it('requires admin role for admin routes', async () => {
    authState.user = standardUser;

    renderAt('/admin/users');

    await screen.findByRole('heading', { name: 'Not found page' });
  });

  it('shows dashboard, banks, imports, and settings navigation for signed-in users', async () => {
    authState.user = standardUser;

    renderAt('/dashboard');

    await screen.findByRole('heading', { name: '学习概览' });

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/dashboard', '/banks', '/imports', '/settings']));
    expect(hrefs).not.toContain('/admin');
  });

  it('shows the admin navigation entry only for administrators', async () => {
    authState.user = adminUser;

    renderAt('/dashboard');

    await screen.findByRole('heading', { name: '学习概览' });

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toContain('/admin');
  });
});
