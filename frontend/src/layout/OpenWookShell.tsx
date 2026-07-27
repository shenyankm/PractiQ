import { useState, type ReactNode } from 'react';
import { Link, Button } from '@heroui/react';
import { useLocation } from 'react-router-dom';
import { apiRequest } from '@/lib/api';
import type { AuthUser } from '@/auth/AuthProvider';

type NavItem = { href: string; label: string; adminOnly?: boolean };
const navItems: NavItem[] = [
  { href: '/dashboard', label: '仪表板' },
  { href: '/banks', label: '题库' },
  { href: '/imports', label: '导入' },
  { href: '/settings', label: '设置' },
  { href: '/admin', label: '后台', adminOnly: true }
] as const;

export function OpenWookShell({ children, user }: { children: ReactNode; user: AuthUser }) {
  const { pathname } = useLocation();
  const [loggingOut, setLoggingOut] = useState(false);
  const visibleNav = navItems.filter((item) => !item.adminOnly || user.role === 'admin');

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap items-center gap-4">
          <Link className="font-semibold" href="/dashboard">OpenWook</Link>
          {visibleNav.map((item) => (
            <Link key={item.href} href={item.href} aria-current={pathname === item.href || pathname.startsWith(item.href + '/') ? 'page' : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        <Button
          type="button"
          isDisabled={loggingOut}
          onPress={async () => {
            setLoggingOut(true);
            try {
              await apiRequest('/api/v1/auth/logout', { method: 'POST' });
              window.location.assign('/sign-in');
            } finally {
              setLoggingOut(false);
            }
          }}
        >
          退出
        </Button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  );
}
