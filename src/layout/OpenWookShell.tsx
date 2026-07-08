import { useState, type ReactNode } from 'react';
import { Link, Button } from '@heroui/react';
import { useLocation } from 'react-router-dom';
import { api } from '@/src/lib/api';
import type { AuthUser } from '@/src/auth/AuthProvider';

const navItems = [
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
    <div>
      <header>
        <nav>
          <Link href="/dashboard">OpenWook</Link>
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
              await api.logout();
              window.location.assign('/sign-in');
            } finally {
              setLoggingOut(false);
            }
          }}
        >
          退出
        </Button>
      </header>
      <main>{children}</main>
    </div>
  );
}
