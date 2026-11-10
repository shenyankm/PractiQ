import { useEffect, useState, type ReactNode } from "react";
import { accountRequest } from "../../shared/cloud/accountClient";
import { AccountError, errorMessage } from "../../shared/cloud/accountUI";
import type { AdministrationFilter } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Select, SelectOption } from "./components/ui/select";

export type AdminPage = "users" | "tasks" | "payments" | "usage" | "audit" | "settings" | "operations" | "account";
export type AdminNavigate = (page: AdminPage, filters?: AdministrationFilter, id?: string) => void;
export const dateText = (value: string | null | undefined) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未记录";
export function query(filters: AdministrationFilter = {}, offset = 0) {
  const params = new URLSearchParams({ offset: String(offset) });
  Object.entries(filters).forEach(([key, value]) => { if (key !== "offset" && value !== "" && value != null) params.set(key, String(value)); });
  return params.toString();
}
export function useAdminRead<T>(path: string) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setData(null); setError("");
    void accountRequest<T>(path, "GET", undefined, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, revision]);
  return { data, error, loading, reload: () => setRevision(value => value + 1) };
}
export function ReadState({ loading, error, retry }: { loading: boolean; error: string; retry: () => void }) {
  return <>{loading && <p role="status">正在读取…</p>}{error && <AccountError error={error} retry={retry} />}</>;
}
export function Pagination({ offset, size, more, change }: { offset: number; size: number; more: boolean; change: (value: number) => void }) {
  if (offset === 0 && !more) return null;
  return <nav className="admin-pagination" aria-label="记录分页"><Button variant="outline" disabled={!offset} onClick={() => change(Math.max(0, offset - size))}>上一页</Button><span>第 {Math.floor(offset / size) + 1} 页</span><Button variant="outline" disabled={!more} onClick={() => change(offset + size)}>下一页</Button></nav>;
}
export function Facts({ children }: { children: ReactNode }) { return <dl className="admin-facts">{children}</dl>; }
export function Fact({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
export const callStates: Record<string, string> = { completed: "已完成", failed: "已失败", unknown: "结果未知", pending: "处理中", reserved: "已预留" };
export const auditActions: Record<string, string> = { allowance_update: "调整免费额度", user_update: "修改用户权限或额度", user_session_revoke: "撤销用户会话", user_token_revoke: "撤销评分令牌", settings_update: "修改注册与默认额度", import_settings_update: "修改识别设置", reset_link_create: "签发密码重置码", password_reset: "重置密码", admin_request: "访问后台数据", payment_refund: "发起退款", users_read: "查看用户列表", user_detail_read: "查看用户详情", user_sessions_read: "查看用户会话", user_tokens_read: "查看评分令牌", usage_summary_read: "查看用量汇总", usage_read: "查看调用记录", task_search: "查看任务列表", operations_read: "查看运行状态", profile_update: "修改账户信息", grading_token_create: "创建评分令牌", grading_token_revoke: "撤销评分令牌", bootstrap_admin: "创建管理员" };
const taskStates = { active: "进行中", paused: "已暂停", completed: "已完成", cancelled: "已取消", failed: "失败", review: "待复核", interrupted: "已中断", expired: "已过期" };
const paymentStates = { UNKNOWN: "结果未知", PENDING_PAYMENT: "待付款", PAID: "已付款", CLOSED: "已关闭" };
export function FilterBar({ kind, initial = {}, apply }: { kind: "users" | "tasks" | "payments" | "usage" | "audit"; initial?: AdministrationFilter; apply: (filters: AdministrationFilter) => void }) {
  const [draft, setDraft] = useState<AdministrationFilter>(initial);
  const [advanced, setAdvanced] = useState(!!(initial.userId || initial.actor || initial.target || initial.since || initial.until));
  const text = (key: keyof AdministrationFilter, label: string, maxLength = 254) => <label className="account-field" key={key}>{label}<Input maxLength={maxLength} value={String(draft[key] ?? "")} onChange={event => setDraft(value => ({ ...value, [key]: event.target.value }))} /></label>;
  const select = (key: keyof AdministrationFilter, label: string, options: Record<string, string>) => <label className="account-field" key={key}>{label}<Select aria-label={label} className="w-full" value={String(draft[key] ?? "")} onValueChange={next => setDraft(value => ({ ...value, [key]: next || undefined }))}><SelectOption value="">全部</SelectOption>{Object.entries(options).map(([id, name]) => <SelectOption key={id} value={id}>{name}</SelectOption>)}</Select></label>;
  return <form className="admin-filters" data-kind={kind} data-expanded={kind === "audit" && advanced || undefined} aria-label="筛选记录" onSubmit={event => { event.preventDefault(); apply({ ...draft, offset: 0 }); }}>
    {text("q", kind === "users" ? "搜索邮箱、昵称或用户编号" : kind === "tasks" ? "搜索邮箱、文件名或任务编号" : kind === "payments" ? "搜索邮箱、订单编号或名称" : kind === "usage" ? "搜索邮箱、调用或任务编号" : "搜索邮箱或操作对象")}
    {kind !== "users" && kind !== "audit" && text("userId", "用户编号", 128)}
    {kind === "users" && <>{select("issue", "待处理类型", { quota: "识别页数已耗尽" })}{select("role", "角色", { user: "普通用户", admin: "管理员" })}<label className="account-field">账户状态<Select aria-label="账户状态" className="w-full" value={draft.enabled == null ? "" : String(draft.enabled)} onValueChange={next => setDraft(value => ({ ...value, enabled: next === "" ? undefined : next === "true" }))}><SelectOption value="">全部</SelectOption><SelectOption value="true">已启用</SelectOption><SelectOption value="false">已停用</SelectOption></Select></label></>}
    {kind === "tasks" && <>{select("state", "任务状态", taskStates)}{select("issue", "待处理类型", { unknown: "未知调用", blocked: "存在阻塞", quota: "额度或预算不足", stalled: "等待或运行超过 30 分钟" })}</>}
    {kind === "payments" && <>{select("state", "订单状态", paymentStates)}{select("environment", "支付环境", { production: "正式", sandbox: "沙箱" })}{select("issue", "待处理类型", { refund: "退款未确认或权益冻结", unknown: "订单结果未知" })}</>}
    {kind === "usage" && <>{select("kind", "调用类型", { modelCalls: "模型", tencentCalls: "腾讯识别" })}{select("state", "调用状态", callStates)}{text("provider", "供应商或模型", 255)}</>}
    {kind === "audit" && <>{select("action", "操作类型", auditActions)}{advanced && <>{text("userId", "用户编号", 128)}{text("actor", "操作者编号", 128)}{text("target", "对象编号", 255)}</>}</>}
    {(kind !== "audit" || advanced) && (["since", "until"] as const).map(key => <label className="account-field" key={key}>{key === "since" ? "开始时间（UTC）" : "结束时间（UTC，不含）"}<Input type="datetime-local" value={draft[key]?.slice(0, 16) ?? ""} onChange={event => setDraft(value => ({ ...value, [key]: event.target.value ? new Date(event.target.value + "Z").toISOString() : undefined }))} /></label>)}
    <div className="admin-filter-actions"><Button type="submit">应用筛选</Button><Button type="button" variant="outline" onClick={() => { setDraft({}); setAdvanced(false); apply({}); }}>清除筛选</Button>{kind === "audit" && <Button type="button" variant="ghost" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? "收起筛选" : "更多筛选"}</Button>}</div>
  </form>;
}
