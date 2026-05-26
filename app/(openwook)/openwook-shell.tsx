'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  Database,
  FileUp,
  LayoutDashboard,
  LogOut,
  Menu,
  Shield,
  X,
  Settings,
  UserRound
} from 'lucide-react';
import { signOut } from '@/app/(login)/actions';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type ShellUser = {
  username: string;
  membership: 'free' | 'plus';
  role: 'admin' | 'user';
  avatarUrl: string | null;
};

const navItems: Array<{ href: string; label: string; icon: React.ElementType; adminOnly?: boolean }> = [
  { href: '/dashboard', label: '仪表板', icon: LayoutDashboard },
  { href: '/banks', label: '题库', icon: Database },
  { href: '/imports', label: '导入', icon: FileUp },
  { href: '/settings', label: '设置', icon: Settings },
  { href: '/admin', label: '后台', icon: Shield, adminOnly: true }
];

export function OpenWookShell({
  children,
  user
}: {
  children: React.ReactNode;
  user: ShellUser;
}) {
  const pathname = usePathname();

  return <UserShell pathname={pathname} user={user}>{children}</UserShell>;
}

function UserShell({
  children,
  pathname,
  user
}: {
  children: React.ReactNode;
  pathname: string;
  user: ShellUser;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const visibleNavItems = navItems.filter((item) => !item.adminOnly || user.role === 'admin');

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgb(0_0_0_/_0.06),transparent_28rem),radial-gradient(circle_at_bottom_right,rgb(0_0_0_/_0.04),transparent_24rem),var(--background)] text-foreground dark:bg-[radial-gradient(circle_at_top_left,rgb(255_255_255_/_0.08),transparent_28rem),radial-gradient(circle_at_bottom_right,rgb(255_255_255_/_0.05),transparent_24rem),var(--background)]">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/80 shadow-sm backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 lg:px-8">
          <Link href="/dashboard" className="flex min-w-0 items-center">
            <span className="truncate text-lg font-semibold">OpenWook</span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {visibleNavItems.map((item) => (
              <TopNavLink key={item.href} item={item} pathname={pathname} />
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-controls="mobile-navigation"
              aria-expanded={mobileNavOpen}
              aria-label={mobileNavOpen ? '关闭导航菜单' : '打开导航菜单'}
              onClick={() => setMobileNavOpen((open) => !open)}
            >
              {mobileNavOpen ? <X className="size-4" /> : <Menu className="size-4" />}
            </Button>
            <UserActions user={user} />
          </div>
        </div>

        <nav
          id="mobile-navigation"
          data-testid="mobile-nav-panel"
          data-state={mobileNavOpen ? 'open' : 'closed'}
          aria-hidden={!mobileNavOpen}
          inert={!mobileNavOpen}
          className={cn(
            'mx-auto grid max-w-7xl border-t border-border/70 px-4 transition-[grid-template-rows,opacity] duration-200 ease-out md:hidden motion-reduce:transition-none',
            mobileNavOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
        >
          <div className="flex min-h-0 gap-1 overflow-hidden overflow-x-auto py-2">
            {visibleNavItems.map((item) => (
              <TopNavLink key={item.href} item={item} pathname={pathname} compact />
            ))}
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 lg:px-8 lg:py-8">
        <div
          key={pathname}
          data-testid="route-transition"
          className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-300"
        >
          {children}
        </div>
      </main>
    </div>
  );
}

function TopNavLink({
  compact = false,
  item,
  pathname
}: {
  compact?: boolean;
  item: (typeof navItems)[number];
  pathname: string;
}) {
  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <Link
      href={item.href}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'inline-flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 motion-reduce:transition-none',
        isActive && 'bg-foreground/10 text-foreground shadow-xs',
        compact && 'h-9'
      )}
    >
      <item.icon className="size-4" />
      {item.label}
    </Link>
  );
}

function UserActions({ user }: { user: ShellUser }) {
  const avatarUrl = httpUrlOrNull(user.avatarUrl);

  return (
    <div className="flex shrink-0 items-center gap-3">
      <div className="hidden items-center gap-2 sm:flex">
        <Avatar className="size-8">
          {avatarUrl ? <AvatarImage src={avatarUrl} alt={user.username} /> : null}
          <AvatarFallback className="bg-foreground/10 text-xs font-semibold text-foreground">
            {user.username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="leading-tight">
          <div className="max-w-32 truncate text-sm font-medium">{user.username}</div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <UserRound className="size-3" />
            {user.membership}
          </div>
        </div>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            <LogOut className="size-4" />
            退出
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认退出登录</AlertDialogTitle>
            <AlertDialogDescription>
              退出后需要重新登录才能继续管理题库、导入任务和练习记录。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <form action={signOut}>
              <AlertDialogAction type="submit" className="w-full bg-destructive text-destructive-foreground hover:bg-destructive/90 sm:w-auto">
                确认退出
              </AlertDialogAction>
            </form>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function httpUrlOrNull(value: string | null) {
  return value && /^https?:\/\//.test(value) ? value : null;
}
