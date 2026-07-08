// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const authState = vi.hoisted(() => ({
  user: null as null | {
    username: string;
    membership: 'free' | 'plus' | 'enterprise';
    role: 'admin' | 'user';
    avatarUrl: string | null;
    avatarOptimized: boolean;
  },
  isLoading: false
}));

function stubPage(label: string) {
  return function StubPage() {
    return <h1>{label}</h1>;
  };
}

vi.mock('@/src/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: authState.user,
    isLoading: authState.isLoading,
    isAuthenticated: Boolean(authState.user)
  })
}));

vi.mock('@/src/lib/api', () => ({
  api: {
    logout: vi.fn().mockResolvedValue(undefined)
  }
}));

vi.mock('@/src/pages/PricingPage', () => ({ default: stubPage('Pricing page') }));
vi.mock('@/src/pages/LoginPage', () => ({ default: stubPage('Login page') }));
vi.mock('@/src/pages/DashboardPage', () => ({ default: stubPage('Dashboard page') }));
vi.mock('@/src/pages/BanksPage', () => ({ default: stubPage('Banks page') }));
vi.mock('@/src/pages/NewBankPage', () => ({ default: stubPage('New bank page') }));
vi.mock('@/src/pages/BankDetailPage', () => ({ default: stubPage('Bank detail page') }));
vi.mock('@/src/pages/BankManagePage', () => ({ default: stubPage('Bank manage page') }));
vi.mock('@/src/pages/PracticeSetupPage', () => ({ default: stubPage('Practice setup page') }));
vi.mock('@/src/pages/PracticeSessionPage', () => ({ default: stubPage('Practice session page') }));
vi.mock('@/src/pages/ImportsPage', () => ({ default: stubPage('Imports page') }));
vi.mock('@/src/pages/ImportDetailPage', () => ({ default: stubPage('Import detail page') }));
vi.mock('@/src/pages/QuestionDetailPage', () => ({ default: stubPage('Question detail page') }));
vi.mock('@/src/pages/SettingsPage', () => ({ default: stubPage('Settings page') }));
vi.mock('@/src/pages/AdminPage', () => ({ default: stubPage('Admin page') }));
vi.mock('@/src/pages/AdminKnowledgePointsPage', () => ({ default: stubPage('Admin knowledge points page') }));
vi.mock('@/src/pages/AdminUsersPage', () => ({ default: stubPage('Admin users page') }));
vi.mock('@/src/pages/NotFoundPage', () => ({ default: stubPage('Not found page') }));

import { AppRouter } from '@/src/routes';

const standardUser = {
  username: 'tester',
  membership: 'free' as const,
  role: 'user' as const,
  avatarUrl: null,
  avatarOptimized: false
};

const adminUser = {
  username: 'admin',
  membership: 'plus' as const,
  role: 'admin' as const,
  avatarUrl: null,
  avatarOptimized: false
};

function renderAt(pathname: string) {
  window.history.replaceState({}, '', pathname);
  return render(<AppRouter />);
}

describe('Vite React router and shell', () => {
  beforeEach(() => {
    authState.user = null;
    authState.isLoading = false;
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    cleanup();
  });

  it('redirects / to /dashboard for signed-in users', async () => {
    authState.user = standardUser;

    renderAt('/');

    await screen.findByRole('heading', { name: 'Dashboard page' });
    await waitFor(() => expect(window.location.pathname).toBe('/dashboard'));
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

    await screen.findByRole('heading', { name: 'Dashboard page' });

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/dashboard', '/banks', '/imports', '/settings']));
    expect(hrefs).not.toContain('/admin');
  });

  it('shows the admin navigation entry only for administrators', async () => {
    authState.user = adminUser;

    renderAt('/dashboard');

    await screen.findByRole('heading', { name: 'Dashboard page' });

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toContain('/admin');
  });
});
