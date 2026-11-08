import { nativeBridge } from "./transport";
import { lazy, Suspense, useState } from "react";
import { accountRequest } from "./accountClient";
import { useAccount } from "./useAccount";
import { Field, Form } from "./accountUI";
import { AccountSettings, Banks, Usage } from "./CustomerViews";
import { Payments } from "./Payments";
import type { AccountSession, AccountUser } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import logo from "./assets/octopus.png";
const Workspace = lazy(() => import("./App"));

export default function AccountPortal({ embedded = false, initialPage = "workspace" }: { embedded?: boolean; initialPage?: "workspace" | "account" } = {}) {
  const auth = useAccount();
  const [mode, setMode] = useState("login");
  const [focusMain, setFocusMain] = useState(false);
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [token, setToken] = useState("");
  const user = auth.user;
  function changeMode(value: string) { setMode(value); setPassword(""); setToken(""); auth.setError(""); }
  return <>
    {!embedded && user && <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); setFocusMain(true); const main = document.getElementById("main-content"); main?.focus(); main?.scrollIntoView(); }}>跳到主要内容</a>}
    <header className="account-header">
      {!embedded && <a href="#"><img src={logo} alt="" />PractiQ</a>}
      {user && <><span>{user.name || user.email}</span><Button variant="outline" onClick={() => { if (document.dispatchEvent(new Event("practiq-cloud-before-leave", {cancelable:true}))) void auth.logout(); }}>退出登录</Button></>}
    </header>
    {auth.error && <p role="alert">{auth.error}</p>}
    {auth.loading ? <p role="status">正在读取登录状态…</p> : !user ? <section className="account-card">
      <h1>{mode === "reset" ? "重置密码" : mode === "register" ? "注册 PractiQ" : "登录 PractiQ"}</h1>
      {mode === "register" && !auth.account?.registrationEnabled && <p role="status">公开注册暂未开放，请联系管理员。</p>}
      {auth.account && (mode !== "register" || auth.account.registrationEnabled) && <Form label={mode === "reset" ? "设置新密码" : mode === "register" ? "注册并登录" : "登录"} submit={async () => {
        if (mode === "reset") { await accountRequest("/api/auth/reset-password", "POST", { token, password }); changeMode("login"); auth.reload(); }
        else { auth.signedIn(await accountRequest<AccountSession>(mode === "register" ? "/api/auth/register" : "/api/auth/login", "POST", { email, password })); setMode("login"); setPassword(""); }
      }}>
        {mode === "reset" ? <Field name="reset-code" label="管理员提供的一次性重置码" type="password" autoComplete="off" value={token} onChange={setToken} /> : <Field name="login-email" label="登录邮箱" type="email" value={email} onChange={setEmail} />}
        <label className="account-field">{mode === "login" ? "密码" : "密码（至少 12 字符）"}<Input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={12} maxLength={128} required value={password} onChange={e => setPassword(e.target.value)} /></label>
      </Form>}
      <p>登录邮箱仅作为账户标识，无需接收验证邮件。忘记密码请联系管理员核实身份，获取一次性重置码。</p>
      {mode !== "login" && <Button variant="ghost" onClick={() => changeMode("login")}>返回登录</Button>}
      {auth.account?.registrationEnabled && <Button variant="ghost" onClick={() => changeMode("register")}>注册账户</Button>}
      <Button variant="ghost" onClick={() => changeMode("reset")}>重置密码</Button>
      <Button variant="outline" onClick={auth.reload}>重新读取登录状态</Button>
    </section> : <CustomerArea key={user.id} user={user} initialPage={initialPage} focusMain={focusMain} onNameSaved={name => auth.updateName(user.id, name)} />}
  </>;
}

function CustomerArea({ user, initialPage, focusMain, onNameSaved }: { user: AccountUser; initialPage: "workspace" | "account"; focusMain: boolean; onNameSaved: (name: string) => void }) {
  const Content = nativeBridge() ? "section" : "main";
  const [page, setPage] = useState<string>(initialPage);
  const [task, setTask] = useState<{id: string}>();
  return <>
      <nav className="account-navigation" aria-label="个人导航">{[["workspace", "导入工作区"], ["banks", "我的题库"], ["usage", "用量"], ["plans", "套餐与额度"], ["payments", "订单与付款"], ["account", "账户与安全"]].map(([id, label]) => <Button key={id} variant={page === id ? "secondary" : "ghost"} onClick={() => setPage(id)}>{label}</Button>)}</nav>
      <div key={user.id}>
        <div hidden={page !== "workspace"}><Suspense fallback={<p>正在载入工作区…</p>}><Workspace requestedTask={task} hideSkipLink focusMain={focusMain} /></Suspense></div>
        {page !== "workspace" && <Content className="account-content">{page === "banks" ? <Banks open={id => { setTask({ id }); location.hash = "records"; setPage("workspace"); }} /> : page === "usage" ? <Usage /> : (page === "plans" || page === "payments") ? <Payments key={page} view={page === "plans" ? "plans" : "orders"} onNavigate={setPage} /> : <AccountSettings user={user} onNameSaved={onNameSaved} />}</Content>}
      </div>
    </>;
}
