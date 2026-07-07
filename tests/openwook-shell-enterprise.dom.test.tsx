// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OpenWookShell } from '@/app/(openwook)/openwook-shell';

const navigationMock = vi.hoisted(() => ({
  pathname: '/settings'
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

describe('OpenWookShell enterprise membership', () => {
  it('renders enterprise membership text in the shared shell', () => {
    render(
      <OpenWookShell
        user={{
          username: 'enterprise-user',
          membership: 'enterprise',
          avatarUrl: null,
          avatarOptimized: false,
          role: 'user'
        }}
      >
        <div>Settings</div>
      </OpenWookShell>
    );

    expect(screen.getByText('enterprise')).toBeTruthy();
  });
});
