import { useState } from "react";
import { accountRequest as request } from "../../shared/cloud/accountClient";
import { Field, Form, errorMessage } from "../../shared/cloud/accountUI";
import type { AccountSessionInfo, AccountTokenInfo, AdministrationUserDetail } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Fact, Facts, Pagination, ReadState, dateText, useAdminRead, type AdminNavigate } from "./adminTools";

function Credentials({ userId, kind, changed }: { userId: string; kind: "sessions" | "tokens"; changed: () => void }) {
  const [offset, setOffset] = useState(0), [password, setPassword] = useState(""), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const read = useAdminRead<(AccountSessionInfo | AccountTokenInfo)[]>(`/api/admin/users/${encodeURIComponent(userId)}/${kind}?offset=${offset}`);
  async function revoke(id?: string) {
    if (busy || !password || !reason.trim()) return;
    const label = id ? "撤销此凭证" : "撤销该用户的全部登录会话";
    if (!window.confirm(`${label}？已撤销的凭证将立即失效。`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`/api/admin/users/${encodeURIComponent(userId)}/${kind}${id ? "/" + encodeURIComponent(id) : ""}`, "DELETE", { currentPassword: password, reason: reason.trim() });
      setNotice("撤销已完成。"); read.reload(); changed();
    } catch (error) { setError(errorMessage(error) + " 请重新读取并核对原记录，不会自动重发撤销操作。"); }
    finally { setPassword(""); setBusy(false); }
  }
  return <section className="admin-section" aria-label={kind === "sessions" ? "用户登录会话" : "用户评分令牌"}>
    <h3>{kind === "sessions" ? "有效登录会话" : "有效评分令牌"}</h3>
    <ReadState {...read} retry={read.reload} />{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <fieldset disabled={busy} className="admin-credential-controls"><legend>撤销凭证需要验证身份并说明原因</legend><Field name={`${kind}-password`} label="管理员当前密码" type="password" value={password} onChange={setPassword} /><label className="account-field">撤销原因<Input required maxLength={200} value={reason} onChange={event => setReason(event.target.value)} /></label>{kind === "sessions" && <Button variant="outline" disabled={busy || !password || !reason.trim()} onClick={() => void revoke()}>撤销全部登录会话</Button>}</fieldset>
    {read.data && !read.data.length && <p>没有有效{kind === "sessions" ? "会话" : "令牌"}。</p>}
    {!!read.data?.length && <div className="account-table"><table><thead><tr><th>凭证</th><th>创建时间</th><th>最近活动 / 到期</th><th>操作</th></tr></thead><tbody>{read.data.map(row => <tr key={row.id}><td>{"name" in row ? row.name : "登录会话"}<small>{row.id}</small></td><td>{dateText("createdAt" in row ? row.createdAt : row.created_at)}</td><td>{"lastSeen" in row ? <>最近活动 {dateText(row.lastSeen)}<small>到期 {dateText(row.expiresAt)}</small></> : dateText(row.expires_at)}</td><td><Button variant="outline" disabled={busy || !password || !reason.trim()} onClick={() => void revoke(row.id)}>撤销此凭证</Button></td></tr>)}</tbody></table></div>}
    <Pagination offset={offset} size={100} more={read.data?.length === 100} change={setOffset} />
  </section>;
}
export function AdminUserDetails({ id, navigate, changed }: { id: string; navigate: AdminNavigate; changed: () => void }) {
  const read = useAdminRead<AdministrationUserDetail>(`/api/admin/users/${encodeURIComponent(id)}`);
  const [pages, setPages] = useState(""), [password, setPassword] = useState(""), [reason, setReason] = useState("");
  const [security, setSecurity] = useState(false);
  const value = read.data;
  const parsed = pages.trim() === "" ? null : Number(pages);
  const valid = parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 1_000_000;
  const afterFree = value && valid ? Math.max(0, parsed! - value.balance.freeUsedPages) : null;
  return <section className="admin-section" aria-label="用户详情">
    <div className="section-heading"><h2>用户详情</h2><Button variant="outline" onClick={read.reload}>刷新用户详情</Button></div><ReadState {...read} retry={read.reload} />
    {value && <>
      <p>{value.user.email} · {value.user.name || "未设置昵称"} · {value.user.enabled ? "已启用" : "已停用"} · {value.user.id}</p>
      <Facts><Fact label="当前套餐">{value.balance.plan} · {value.balance.expiresAt ? `到期 ${dateText(value.balance.expiresAt)}` : "免费额度长期有效"}</Fact><Fact label="可用识别页数">{value.balance.remainingPages} 页</Fact><Fact label="免费总额度 / 已用或预留">{value.balance.freePages} / {value.balance.freeUsedPages} 页</Fact><Fact label="已确认成功识别">{value.settledPages} 页</Fact><Fact label="保留或待结算页数">{value.heldPages} 页（其中未知 {value.unknownPages} 页）</Fact><Fact label="每日调用上限 / 并发">模型 {value.limits.modelCalls} 次 · 腾讯 {value.limits.tencentCalls} 次 · 任务 {value.limits.activeTasks} 个</Fact><Fact label="有效凭证">会话 {value.activeSessions} 个 · 评分令牌 {value.activeTokens} 个</Fact></Facts>
      <div className="admin-links">{([["tasks", "查看该用户任务"], ["payments", "查看该用户订单"], ["usage", "查看该用户用量"], ["audit", "查看该用户审计"]] as const).map(([page, label]) => <Button key={page} variant="outline" onClick={() => navigate(page, { userId: id })}>{label}</Button>)}<Button variant="outline" onClick={() => navigate("tasks", { userId: id, issue: "quota" })}>排查额度阻塞</Button></div>
      <h3>付费权益</h3>{value.balance.grants.length ? <div className="account-table"><table><thead><tr><th>订单 / 产品</th><th>状态</th><th>已用或预留 / 总页数</th><th>可用</th><th>到期时间</th></tr></thead><tbody>{value.balance.grants.map(grant => <tr key={grant.orderId}><td><Button variant="link" onClick={() => navigate("payments", { userId: id }, grant.orderId)}>{grant.orderId}</Button><small>{grant.productId}</small></td><td>{{ active: "生效中", expired: "已到期", refund_pending: "退款冻结", refunded: "已退款" }[grant.state]}</td><td className="admin-number">{grant.usedPages} / {grant.totalPages}</td><td className="admin-number">{grant.remainingPages}</td><td>{dateText(grant.expiresAt)}</td></tr>)}</tbody></table></div> : <p>没有付费权益，免费余额仍保留。</p>}
      <h3>调整免费总额度</h3><p>设置包含已用及预留页数的总额度。保留全部调用回执，付费权益不受影响。</p>
      <Form label="确认调整总额度" submit={async () => {
        if (!valid) throw Error("请输入 0 到 1000000 的整数页数。");
        try { await request(`/api/admin/users/${encodeURIComponent(id)}/allowance`, "POST", { currentPassword: password, expectedFreePages: value.balance.freePages, freePages: parsed, reason: reason.trim() }); setPages(""); setReason(""); read.reload(); changed(); }
        finally { setPassword(""); }
      }}><label className="account-field">新的免费总额度（页）<Input type="number" required min={0} max={1_000_000} step={1} value={pages} onChange={event => setPages(event.target.value)} /></label><label className="account-field">调整原因<Input required maxLength={200} value={reason} onChange={event => setReason(event.target.value)} /></label><Field name="allowance-password" label="管理员当前密码" type="password" value={password} onChange={setPassword} />
        <p role="status">当前总额度 {value.balance.freePages} 页，可用免费页数 {value.balance.freeRemainingPages} 页。{afterFree !== null && <>调整后总额度 {parsed} 页，可用免费页数 {afterFree} 页；全部可用页数 {afterFree + value.balance.remainingPages - value.balance.freeRemainingPages} 页。</>}</p>
      </Form>
      <div className="admin-section"><Button variant="outline" aria-expanded={security} onClick={() => setSecurity(!security)}>管理该用户会话与令牌</Button>{security && <><Credentials userId={id} kind="sessions" changed={read.reload} /><Credentials userId={id} kind="tokens" changed={read.reload} /></>}</div>
    </>}
  </section>;
}
