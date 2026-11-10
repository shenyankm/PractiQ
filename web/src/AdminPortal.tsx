import { useState } from "react";
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

export default function AdminPortal() {
  const auth = useAccount();
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [location, setLocation] = useState<{ page: AdminPage; filters: AdministrationFilter; id?: string }>({ page: "users", filters: {} });
  const { page, filters, id } = location;
  const navigate: AdminNavigate = (page, filters = {}, id) => setLocation({ page, filters, id });
  return <div className="cloud-portal">
    <header className="account-header"><a href="/admin"><img src={logo} alt="" />PractiQ 管理</a>{auth.user && <><span>{auth.user.name || auth.user.email}</span><Button variant="outline" onClick={() => void auth.logout()}>退出登录</Button></>}</header>
    {auth.user && auth.error && <div className="account-notice"><AccountError error={auth.error} /></div>}
    {auth.loading ? <p role="status">正在读取登录状态…</p> : !auth.user ? <section className="account-card"><h1>管理员登录 PractiQ</h1>
      {auth.error && <AccountError error={auth.error} />}
      {!auth.account && <Button variant="outline" onClick={auth.reload}>重新读取登录状态</Button>}
      {auth.account && <Form label="登录" submit={async () => { auth.signedIn(await accountRequest<AccountSession>("/api/auth/login", "POST", { email, password })); setPassword(""); }}><Field name="admin-email" label="登录邮箱" type="email" value={email} onChange={setEmail} /><Field name="admin-password" label="密码" type="password" value={password} onChange={setPassword} /></Form>}
    </section> : auth.user.role !== "admin" ? <p role="alert" className="error-banner">没有管理权限。用户功能已迁至 PractiQ App，请使用 App 登录。</p> : <div className="account-layout">
      <nav aria-label="管理导航">{[["operations", "运行状态"], ["users", "用户"], ["tasks", "任务"], ["payments", "订单与退款"], ["usage", "提供商用量"], ["settings", "系统设置"], ["audit", "审计"], ["account", "账户与安全"]].map(([id, label]) => <Button key={id} variant={page === id ? "secondary" : "ghost"} aria-current={page === id ? "page" : undefined} onClick={() => navigate(id as AdminPage)}>{label}</Button>)}</nav>
      <main className="account-content" key={[auth.user.id, page, JSON.stringify(filters), id].join("/")}>{page === "users" ? <AdminUsers initial={filters} initialId={id} navigate={navigate} /> : page === "tasks" ? <AdminTasks initial={filters} initialId={id} navigate={navigate} /> : page === "payments" ? <AdminPayments initial={filters} initialId={id} navigate={navigate} /> : page === "settings" ? <AdminSettings /> : page === "operations" ? <AdminOperations navigate={navigate} /> : page === "usage" ? <AdminUsage initial={filters} navigate={navigate} /> : page === "audit" ? <AdminAudit initial={filters} navigate={navigate} /> : <AccountSettings user={auth.user} onNameSaved={name => { if (auth.user) auth.updateName(auth.user.id, name); }} />}</main>
    </div>}
  </div>;
}
