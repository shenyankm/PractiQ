import { useEffect, useState } from "react";
import { cn } from "cn";
import { LockKeyhole, Mail } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { accountRequest } from "../../shared/cloud/accountClient";
import { useAccount } from "../../shared/cloud/useAccount";
import { AccountError, Field, Form } from "../../shared/cloud/accountUI";
import { AccountSettings } from "../../shared/cloud/CustomerViews";
import type { AccountSession } from "./contracts.generated";
import { AdminUsers, AdminTasks, AdminSettings } from "./AdminViews";
import { Button } from "./components/ui/button";
import { AdminPayments } from "./AdminPayments";
import { AdminAudit, AdminOperations, AdminUsage } from "./AdminReports";
import type { AdminNavigate, AdminPage } from "./adminTools";
import type { AdministrationFilter } from "./contracts.generated";
import logo from "../../shared/cloud/assets/octopus.png";
const adminPages = [["operations", "运行状态"], ["users", "用户"], ["tasks", "任务"], ["payments", "订单与退款"], ["usage", "提供商用量"], ["settings", "系统设置"], ["audit", "审计"], ["account", "账户与安全"]] as const;
function pageFromHash(): AdminPage { return adminPages.find(([page]) => page === window.location.hash.slice(1))?.[0] ?? "users"; }

export default function AdminPortal() {
  const auth = useAccount();
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [loggingOut, setLoggingOut] = useState(false), [location, setLocation] = useState<{ page: AdminPage; filters: AdministrationFilter; id?: string }>(() => ({ page: pageFromHash(), filters: {} }));
  useEffect(() => {
    const change = () => { const page = pageFromHash(); setLocation(current => current.page === page ? current : { page, filters: {} }); };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const { page, filters, id } = location;
  const navigate: AdminNavigate = (page, filters = {}, id) => { setLocation({ page, filters, id }); window.location.hash = page; };
  return <div className="cloud-portal admin-portal">
    <header className="account-header"><a href="/admin"><img src={logo} alt="" />PractiQ 管理</a>{auth.user && <><span>{auth.user.name || auth.user.email}</span><AlertDialog.Root>
      <AlertDialog.Trigger asChild><Button variant="outline" disabled={loggingOut}>{loggingOut ? "正在退出…" : "退出登录"}</Button></AlertDialog.Trigger>
      <AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40" /><AlertDialog.Content data-slot="alert-dialog-content" className="admin-logout-dialog fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-5 bg-popover p-6 text-popover-foreground outline-none">
        <div><AlertDialog.Title className="text-xl font-semibold">确认退出登录？</AlertDialog.Title><AlertDialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">退出后需要重新登录，才能继续使用管理后台。</AlertDialog.Description></div>
        <div className="flex flex-wrap justify-end gap-3"><AlertDialog.Cancel asChild><Button variant="outline">取消</Button></AlertDialog.Cancel><AlertDialog.Action asChild><Button onClick={() => { setLoggingOut(true); void auth.logout().finally(() => setLoggingOut(false)); }}>确认退出</Button></AlertDialog.Action></div>
      </AlertDialog.Content></AlertDialog.Portal>
    </AlertDialog.Root></>}</header>
    {auth.user && auth.error && <div className="account-notice"><AccountError error={auth.error} /></div>}
    {auth.loading ? <p role="status">正在读取登录状态…</p> : !auth.user ? <main className="admin-login" aria-labelledby="admin-login-title"><section className="account-card"><h1 id="admin-login-title">登录管理后台</h1>
      {auth.error && <AccountError error={auth.error} />}
      {!auth.account && <Button variant="outline" onClick={auth.reload}>重新读取登录状态</Button>}
      {auth.account && <Form label="登录" submit={async () => { auth.signedIn(await accountRequest<AccountSession>("/api/auth/login", "POST", { email, password })); setPassword(""); }}><Field name="admin-email" label="登录邮箱" type="email" value={email} onChange={setEmail} icon={<Mail />} /><Field name="admin-password" label="密码" type="password" value={password} onChange={setPassword} icon={<LockKeyhole />} /></Form>}
    </section></main> : auth.user.role !== "admin" ? <p role="alert" className="error-banner">没有管理权限。用户功能已迁至 PractiQ App，请使用 App 登录。</p> : <div className="account-layout">
      <nav aria-label="管理导航">{adminPages.map(([id, label]) => <Button key={id} variant={page === id ? "secondary" : "ghost"} aria-current={page === id ? "page" : undefined} onClick={() => navigate(id)}>{label}</Button>)}</nav>
      <main className={cn("account-content", page === "settings" && "admin-content-form")} key={[auth.user.id, page, JSON.stringify(filters), id].join("/")}>{page === "users" ? <AdminUsers initial={filters} initialId={id} navigate={navigate} /> : page === "tasks" ? <AdminTasks initial={filters} initialId={id} navigate={navigate} /> : page === "payments" ? <AdminPayments initial={filters} initialId={id} navigate={navigate} /> : page === "settings" ? <AdminSettings /> : page === "operations" ? <AdminOperations navigate={navigate} /> : page === "usage" ? <AdminUsage initial={filters} navigate={navigate} /> : page === "audit" ? <AdminAudit initial={filters} navigate={navigate} /> : <AccountSettings user={auth.user} onNameSaved={name => { if (auth.user) auth.updateName(auth.user.id, name); }} />}</main>
    </div>}
  </div>;
}
