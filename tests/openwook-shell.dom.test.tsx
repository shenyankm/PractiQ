// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OpenWookShell } from '@/app/(openwook)/openwook-shell';

const navigationMock = vi.hoisted(() => ({
  pathname: '/dashboard'
}));

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
  signOut: vi.fn()
}));

describe('OpenWookShell', () => {
  it('renders the text logo without a leading icon', () => {
    navigationMock.pathname = '/dashboard';

    render(
      <OpenWookShell user={{ username: 'tester', membership: 'free', avatarUrl: null, avatarOptimized: false, role: 'user' }}>
        <div>Dashboard</div>
      </OpenWookShell>
    );

    const brandLink = screen.getByRole('link', { name: 'OpenWook' });

    expect(brandLink.querySelector('svg')).toBeNull();
  });

  it('keeps user navigation at the top on bank pages', () => {
    navigationMock.pathname = '/banks';

    const { container } = render(
      <OpenWookShell user={{ username: 'tester', membership: 'free', avatarUrl: null, avatarOptimized: false, role: 'user' }}>
        <div>Bank list</div>
      </OpenWookShell>
    );

    expect(container.querySelector('aside')).toBeNull();
    expect(screen.getByRole('banner').querySelector('a[href="/banks"]')?.textContent).toContain('题库');
  });

  it('marks the current page and removes closed mobile navigation from assistive navigation', () => {
    navigationMock.pathname = '/banks';

    render(
      <OpenWookShell user={{ username: 'tester', membership: 'free', avatarUrl: null, avatarOptimized: false, role: 'user' }}>
        <div>Bank list</div>
      </OpenWookShell>
    );

    const currentLinks = screen.getAllByRole('link', { name: /题库/ });
    expect(currentLinks.some((link) => link.getAttribute('aria-current') === 'page')).toBe(true);

    const mobilePanel = screen.getByTestId('mobile-nav-panel');
    expect(mobilePanel.getAttribute('aria-hidden')).toBe('true');
    expect(mobilePanel.hasAttribute('inert')).toBe(true);
  });

  it('asks for confirmation before signing out', () => {
    navigationMock.pathname = '/dashboard';

    render(
      <OpenWookShell user={{ username: 'tester', membership: 'free', avatarUrl: null, avatarOptimized: false, role: 'user' }}>
        <div>Dashboard</div>
      </OpenWookShell>
    );

    fireEvent.click(screen.getByRole('button', { name: /退出/ }));

    expect(screen.getByRole('alertdialog', { name: '确认退出登录' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认退出' })).toBeTruthy();
  });

  it('shows the admin navigation entry only to administrators', () => {
    navigationMock.pathname = '/dashboard';

    const { rerender } = render(
      <OpenWookShell user={{ username: 'tester', membership: 'free', avatarUrl: null, avatarOptimized: false, role: 'user' }}>
        <div>Dashboard</div>
      </OpenWookShell>
    );

    expect(screen.queryByRole('link', { name: /后台/ })).toBeNull();

    rerender(
      <OpenWookShell user={{ username: 'admin', membership: 'plus', avatarUrl: null, avatarOptimized: false, role: 'admin' }}>
        <div>Dashboard</div>
      </OpenWookShell>
    );

    expect(screen.getAllByRole('link', { name: /后台/ })[0].getAttribute('href')).toBe('/admin');
  });
});
