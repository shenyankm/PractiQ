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
      <OpenWookShell user={{ username: 'tester', membership: 'free', avatarUrl: null }}>
        <div>Dashboard</div>
      </OpenWookShell>
    );

    const brandLink = screen.getByRole('link', { name: 'OpenWook' });

    expect(brandLink.querySelector('svg')).toBeNull();
  });

  it('keeps user navigation at the top on bank pages', () => {
    navigationMock.pathname = '/banks';

    const { container } = render(
      <OpenWookShell user={{ username: 'tester', membership: 'free', avatarUrl: null }}>
        <div>Bank list</div>
      </OpenWookShell>
    );

    expect(container.querySelector('aside')).toBeNull();
    expect(screen.getByRole('banner').querySelector('a[href="/banks"]')?.textContent).toContain('题库');
  });

  it('asks for confirmation before signing out', () => {
    navigationMock.pathname = '/dashboard';

    render(
      <OpenWookShell user={{ username: 'tester', membership: 'free', avatarUrl: null }}>
        <div>Dashboard</div>
      </OpenWookShell>
    );

    fireEvent.click(screen.getByRole('button', { name: /退出/ }));

    expect(screen.getByRole('alertdialog', { name: '确认退出登录' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认退出' })).toBeTruthy();
  });
});
