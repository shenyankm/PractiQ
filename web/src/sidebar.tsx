import { useRef, useState, type ComponentProps } from 'react';
import { Button, Disclosure, DisclosureGroup, Link, Separator, Surface, Tooltip, Typography } from '@heroui/react';
import { flushSync } from 'react-dom';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

const iconPaths = {
  home: 'm3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  banks: 'M3 3h6a4 4 0 0 1 4 4v14a4 4 0 0 0-4-4H3Zm18 0h-4a4 4 0 0 0-4 4v14a4 4 0 0 1 4-4h4Z',
  analytics: 'M3 3v18h18M7 16v-4m5 4V7m5 9v-7',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m-2-6h4l1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-3L1 9l2-4 3 1 3-1Z',
};
function NavIcon({ name }: { name: keyof typeof iconPaths }) {
  return <svg aria-hidden="true" focusable="false" className="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d={iconPaths[name]} /></svg>;
}

const groups = [
  { id: 'banks', icon: 'banks', label: '题库管理', links: [
    { to: '/banks', label: '我的题库' },
    { to: '/imports', label: '题目导入' },
    { to: '/search', label: '搜索题目' },
  ] },
  { id: 'analytics', icon: 'analytics', label: '学情分析与统计', links: [
    { to: '/analytics', label: '学情统计' },
  ] },
] as const;

function Navigation({ collapsed = false }: { collapsed?: boolean }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const activeGroup = /^\/(banks|questions|imports|search|tasks)(\/|$)/.test(pathname) ? 'banks'
    : /^\/(analytics|practice)(\/|$)/.test(pathname) ? 'analytics' : null;
  if (collapsed) {
    const links = [{ to: '/', label: '首页', icon: 'home' } as const, ...groups.map(group => ({ to: group.links[0].to, label: group.label, icon: group.icon })), { to: '/settings', label: '系统设置', icon: 'settings' } as const];
    return <div className="flex flex-col items-center gap-2">
      {links.map(link => <Tooltip key={link.to}>
        <Button isIconOnly aria-label={link.label} variant={pathname === link.to || activeGroup === link.icon ? 'secondary' : 'tertiary'} aria-current={pathname === link.to ? 'page' : undefined} onPress={() => navigate(link.to)}><>{link.icon === 'home' ? <img src="/practiq-logo.png" alt="" className="w-8 h-8 shrink-0" /> : <NavIcon name={link.icon} />}</></Button>
        <Tooltip.Content placement="right">{link.label}</Tooltip.Content>
      </Tooltip>)}
    </div>;
  }
  return <div className="flex flex-col gap-2">
    <Button variant={pathname === '/' ? 'secondary' : 'tertiary'} className="w-full justify-start" aria-current={pathname === '/' ? 'page' : undefined} onPress={() => navigate('/')}><NavIcon name="home" />首页</Button>
    <DisclosureGroup key={pathname} defaultExpandedKeys={activeGroup ? [activeGroup] : []} allowsMultipleExpanded className="flex flex-col gap-2">
    {groups.map(group => <Disclosure key={group.id} id={group.id}>
      <Disclosure.Heading>
        <Button slot="trigger" variant="tertiary" className="w-full justify-between"><span className="flex items-center gap-2"><NavIcon name={group.icon} />{group.label}</span><Disclosure.Indicator /></Button>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="flex flex-col items-start gap-4 py-3 pl-4">
          {group.links.map(link => <Link key={link.to} href={link.to}
            render={props => <NavLink {...props as Omit<ComponentProps<typeof NavLink>, 'to'>} to={link.to} />}>
            {link.label}
          </Link>)}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>)}
    </DisclosureGroup>
    <Button variant={pathname.startsWith('/settings') ? 'secondary' : 'tertiary'} className="w-full justify-start" aria-current={pathname.startsWith('/settings') ? 'page' : undefined} onPress={() => navigate('/settings')}><NavIcon name="settings" />系统设置</Button>
  </div>;
}

export function Sidebar() {
  const { pathname } = useLocation();
  const [expanded, setExpanded] = useState(true);
  const transition = useRef<ViewTransition | null>(null);
  function toggleSidebar() {
    transition.current?.skipTransition();
    if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setExpanded(value => !value);
      return;
    }
    transition.current = document.startViewTransition(() => {
      flushSync(() => setExpanded(value => !value));
    });
  }
  return <>
    <aside className="hidden md:block md:shrink-0">
      <Surface className="sticky top-0 flex h-dvh flex-col gap-6 overflow-y-auto p-6">
        <div id="desktop-navigation" className="flex flex-col gap-6">
          {expanded && <div className="flex w-60 flex-col gap-6">
            <Typography.Heading level={2}>PractiQ</Typography.Heading>
            <Separator />
          </div>}
          <nav aria-label="主导航"><Navigation collapsed={!expanded} /></nav>
        </div>
        <Tooltip><Button isIconOnly variant="tertiary" className="mt-auto self-center shrink-0" aria-controls="desktop-navigation"
          aria-label={expanded ? '收起' : '展开'}
          aria-expanded={expanded} onPress={toggleSidebar}>
          <svg aria-hidden="true" focusable="false" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
            <path d={expanded ? 'm16 9-3 3 3 3' : 'm14 9 3 3-3 3'} />
          </svg>
        </Button><Tooltip.Content>{expanded ? '收起侧边栏' : '展开侧边栏'}</Tooltip.Content></Tooltip>
      </Surface>
    </aside>
    <Surface className="p-4 md:hidden">
      <nav aria-label="移动导航">
        <Disclosure key={pathname}>
          <Disclosure.Heading>
            <Button slot="trigger" variant="tertiary" className="w-full justify-between"><span className="flex items-center gap-2"><img src="/practiq-logo.png" alt="" className="h-6 w-6 shrink-0" />PractiQ 导航</span><Disclosure.Indicator /></Button>
          </Disclosure.Heading>
          <Disclosure.Content><Disclosure.Body><Navigation /></Disclosure.Body></Disclosure.Content>
        </Disclosure>
      </nav>
    </Surface>
  </>;
}
