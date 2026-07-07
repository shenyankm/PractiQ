// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenWookShell } from '@/app/(openwook)/openwook-shell';
import { Button } from '@heroui/react/button';

const navigationMock = vi.hoisted(() => ({
  pathname: '/dashboard'
}));

const actionStateMock = vi.hoisted(() => vi.fn());

vi.mock('react', async (importActual) => {
  const actual = await importActual<typeof import('react')>();

  return {
    ...actual,
    useActionState: actionStateMock
  };
});

vi.mock('next/navigation', () => ({
  usePathname: () => navigationMock.pathname
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

vi.mock('@/app/(login)/actions', () => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  signUp: vi.fn()
}));

describe('motion UI affordances', () => {
  beforeEach(() => {
    navigationMock.pathname = '/dashboard';
    actionStateMock.mockReturnValue([{ error: '' }, vi.fn(), false]);
  });

  it('wraps authenticated page content in a route transition surface', () => {
    render(
      <OpenWookShell user={{ username: 'tester', membership: 'free', avatarUrl: null, role: 'user' }}>
        <div>Dashboard</div>
      </OpenWookShell>
    );

    expect(screen.getByTestId('route-transition').className).toContain('motion-safe:animate-in');
    expect(screen.getByTestId('route-transition').textContent).toContain('Dashboard');
  });

  it('animates mobile navigation expand and collapse state', () => {
    render(
      <OpenWookShell user={{ username: 'tester', membership: 'free', avatarUrl: null, role: 'user' }}>
        <div>Dashboard</div>
      </OpenWookShell>
    );

    const trigger = screen.getByRole('button', { name: '打开导航菜单' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('mobile-nav-panel').getAttribute('data-state')).toBe('open');

    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('mobile-nav-panel').getAttribute('data-state')).toBe('closed');
  });

  it('marks pending login submission as busy while showing an animated indicator', async () => {
    actionStateMock.mockReturnValue([{ error: '' }, vi.fn(), true]);
    const { Login } = await import('@/app/(login)/login');

    render(<Login />);

    const submit = screen.getByRole('button', { name: /处理中/ });
    expect(
      submit.hasAttribute('disabled') ||
      submit.getAttribute('aria-disabled') === 'true' ||
      submit.getAttribute('data-disabled') === 'true'
    ).toBe(true);
    expect(submit.querySelector('svg')?.className.baseVal).toContain('animate-spin');
  });

  it('keeps alert dialogs on the shared HeroUI dialog motion language', () => {
    render(
      <OpenWookShell user={{ username: 'tester', membership: 'free', avatarUrl: null, role: 'user' }}>
        <div>Dashboard</div>
      </OpenWookShell>
    );

    fireEvent.click(screen.getByRole('button', { name: /退出/ }));

    const dialog = screen.getByRole('alertdialog', { name: '确认退出登录' });
    expect(dialog.className).toContain('data-[entering]:fade-in-0');
    expect(dialog.className).toContain('data-[entering]:zoom-in-95');
    expect(dialog.className).toContain('data-[entering]:slide-in-from-top-2');
  });

  it('renders buttons through the HeroUI component class contract', () => {
    render(<Button>保存</Button>);

    expect(screen.getByRole('button', { name: '保存' }).className).toContain('button');
  });
});
