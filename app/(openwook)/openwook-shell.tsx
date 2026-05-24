'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BookOpen,
  Database,
  FileUp,
  LayoutDashboard,
  LogOut,
  Settings,
  UserRound
} from 'lucide-react';
import { signOut } from '@/app/(login)/actions';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type ShellUser = {
  username: string;
  membership: 'free' | 'plus';
};

const navItems = [
  { href: '/dashboard', label: '仪表板', icon: LayoutDashboard },
  { href: '/banks', label: '题库', icon: Database },
  { href: '/imports', label: '导入', icon: FileUp },
  { href: '/settings', label: '设置', icon: Settings }
];

const adminRoutePrefixes = ['/banks', '/imports', '/settings'];

export function OpenWookShell({
  children,
  user
}: {
  children: React.ReactNode;
  user: ShellUser;
}) {
  const pathname = usePathname();
  const isAdminRoute = adminRoutePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

  if (isAdminRoute) {
    return <AdminShell pathname={pathname} user={user}>{children}</AdminShell>;
  }

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
  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <header className="sticky top-0 z-20 border-b bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 lg:px-8">
          <Link href="/dashboard" className="flex min-w-0 items-center gap-2">
            <BookOpen className="size-6 shrink-0 text-orange-600" />
            <span className="truncate text-lg font-semibold">OpenWook</span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => (
              <TopNavLink key={item.href} item={item} pathname={pathname} />
            ))}
          </nav>

          <UserActions user={user} />
        </div>

        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto border-t px-4 py-2 md:hidden">
          {navItems.map((item) => (
            <TopNavLink key={item.href} item={item} pathname={pathname} compact />
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 lg:px-8">{children}</main>
    </div>
  );
}

function AdminShell({
  children,
  pathname,
  user
}: {
  children: React.ReactNode;
  pathname: string;
  user: ShellUser;
}) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r bg-white lg:block">
        <div className="flex h-16 items-center gap-2 border-b px-5">
          <BookOpen className="size-6 text-orange-600" />
          <span className="text-lg font-semibold">OpenWook</span>
        </div>
        <nav className="space-y-1 p-3">
          {navItems.map((item) => (
            <SidebarNavLink key={item.href} item={item} pathname={pathname} />
          ))}
        </nav>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 border-b bg-white">
          <div className="flex h-16 items-center justify-between gap-4 px-4 lg:px-8">
            <Link href="/dashboard" className="flex items-center gap-2 lg:hidden">
              <BookOpen className="size-5 text-orange-600" />
              <span className="font-semibold">OpenWook</span>
            </Link>
            <div className="hidden text-sm text-slate-500 lg:block">
              {user.username} · {user.membership}
            </div>
            <UserActions user={user} />
          </div>

          <nav className="flex gap-1 overflow-x-auto border-t px-4 py-2 lg:hidden">
            {navItems.map((item) => (
              <TopNavLink key={item.href} item={item} pathname={pathname} compact />
            ))}
          </nav>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6 lg:px-8">{children}</main>
      </div>
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
      className={cn(
        'inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium text-slate-700 hover:bg-slate-100',
        isActive && 'bg-orange-50 text-orange-700',
        compact && 'h-8'
      )}
    >
      <item.icon className="size-4" />
      {item.label}
    </Link>
  );
}

function SidebarNavLink({
  item,
  pathname
}: {
  item: (typeof navItems)[number];
  pathname: string;
}) {
  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <Link
      href={item.href}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100',
        isActive && 'bg-orange-50 text-orange-700'
      )}
    >
      <item.icon className="size-4" />
      {item.label}
    </Link>
  );
}

function UserActions({ user }: { user: ShellUser }) {
  return (
    <div className="flex shrink-0 items-center gap-3">
      <div className="hidden items-center gap-2 sm:flex">
        <Avatar className="size-8">
          <AvatarFallback className="bg-orange-100 text-xs font-semibold text-orange-700">
            {user.username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="leading-tight">
          <div className="max-w-32 truncate text-sm font-medium">{user.username}</div>
          <div className="flex items-center gap-1 text-xs text-slate-500">
            <UserRound className="size-3" />
            {user.membership}
          </div>
        </div>
      </div>
      <form action={signOut}>
        <Button variant="outline" size="sm">
          <LogOut className="size-4" />
          退出
        </Button>
      </form>
    </div>
  );
}
