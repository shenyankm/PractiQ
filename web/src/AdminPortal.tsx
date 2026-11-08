import { useState } from "react";
import { accountRequest } from "../../shared/cloud/accountClient";
import { useAccount } from "../../shared/cloud/useAccount";
import { Field, Form, Records } from "../../shared/cloud/accountUI";
import { AccountSettings } from "../../shared/cloud/CustomerViews";
import type { AccountSession } from "./contracts.generated";
import { AdminUsers, AdminTasks, AdminSettings } from "./AdminViews";
import { Button } from "./components/ui/button";
import logo from "../../shared/cloud/assets/octopus.png";

export default function AdminPortal() {
  const auth = useAccount();
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [page, setPage] = useState("users");
  return <div className="cloud-portal">
    <header className="account-header"><a href="/admin"><img src={logo} alt="" />PractiQ 管理</a>{auth.user && <><span>{auth.user.name || auth.user.email}</span><Button variant="outline" onClick={() => void auth.logout()}>退出登录</Button></>}</header>
    {auth.error && <p role="alert" className="error-banner">{auth.error}</p>}
    {auth.loading ? <p role="status">正在读取登录状态…</p> : !auth.user ? <section className="account-card"><h1>管理员登录 PractiQ</h1>
      {auth.account && <Form label="登录" submit={async () => { auth.signedIn(await accountRequest<AccountSession>("/api/auth/login", "POST", { email, password })); setPassword(""); }}><Field name="admin-email" label="登录邮箱" type="email" value={email} onChange={setEmail} /><Field name="admin-password" label="密码" type="password" value={password} onChange={setPassword} /></Form>}
    </section> : auth.user.role !== "admin" ? <p role="alert" className="error-banner">没有管理权限。用户功能已迁至 PractiQ App，请使用 App 登录。</p> : <div className="account-layout">
      <nav aria-label="管理导航">{[["users", "用户"], ["tasks", "任务"], ["usage", "提供商用量"], ["settings", "系统设置"], ["audit", "审计"], ["account", "账户与安全"]].map(([id, label]) => <Button key={id} variant={page === id ? "secondary" : "ghost"} aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}>{label}</Button>)}</nav>
      <main className="account-content" key={page}>{page === "users" ? <AdminUsers /> : page === "tasks" ? <AdminTasks /> : page === "settings" ? <AdminSettings /> : page === "account" ? <AccountSettings user={auth.user} onNameSaved={name => { if (auth.user) auth.updateName(auth.user.id, name); }} /> : <><h1>{page === "audit" ? "审计记录" : "提供商调用记录"}</h1><Records path={`/api/admin/${page}`} paginated /></>}</main>
    </div>}
  </div>;
}
