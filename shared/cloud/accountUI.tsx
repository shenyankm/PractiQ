import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { accountRequest as request } from "./accountClient";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
const messages: Record<string, string> = {
  INVALID_CREDENTIALS: "邮箱或密码错误，或账户已停用。",
  CSRF_INVALID: "页面凭证已过期，请刷新后手动重试。",
  AUTH_RATE_LIMITED: "操作过于频繁，请稍后再试。",
  REGISTRATION_DISABLED: "公开注册暂未开放，请联系管理员。",
  EMAIL_UNAVAILABLE: "此邮箱无法使用。",
  LAST_ADMIN: "必须保留至少一位有效管理员。",
  PASSWORD_REQUIRED: "请核对当前密码。",
  RESET_EXPIRED: "重置码已失效，请联系管理员重新生成。",
};
export const errorMessage = (e: unknown) =>
  e instanceof Error
    ? (messages[e.message] ?? e.message)
    : "操作失败，请刷新核对状态后再决定是否重试。";
export function Field({
  name,
  label,
  type = "text",
  value,
  onChange,
  min,
  max,
  readOnly = false,
  autoComplete,
}: {
  name: string;
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  readOnly?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="account-field" htmlFor={name}>
      {label}
      <Input
        id={name}
        name={name}
        type={type}
        value={value}
        required
        readOnly={readOnly}
        min={min}
        max={max}
        minLength={type === "password" ? 1 : undefined}
        maxLength={type === "password" ? 128 : 254}
        autoComplete={
          autoComplete ?? (type === "password"
            ? "current-password"
            : type === "email"
              ? "email"
              : "off")
        }
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function Form({
  children,
  submit,
  label,
}: {
  children: ReactNode;
  submit: () => Promise<void>;
  label: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  async function send(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await submit();
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="account-form" onSubmit={(e) => void send(e)}>
      <fieldset disabled={busy}>
        {children}
        <Button type="submit">{busy ? "正在处理…" : label}</Button>
      </fieldset>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {saved && <p role="status">操作已完成。</p>}
    </form>
  );
}
export function Records({ path, refresh = 0, onSelect, paginated = false }: { path: string; refresh?: number; onSelect?: (row: Record<string, unknown>) => void; paginated?: boolean }) {
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setRows([]);
    setLoading(true);
    void request<Record<string, unknown>[]>(
      paginated ? `${path}${path.includes("?") ? "&" : "?"}offset=${offset}` : path,
      "GET",
      undefined,
      controller.signal,
    )
      .then(value => { if (!controller.signal.aborted) setRows(value); })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, refresh, paginated, offset]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">正在读取记录…</p>}
      {!loading && !rows.length && !error && <p>暂无记录。</p>}
      {!!rows.length && (
        <div className="account-table">
          <table>
            <thead>
              <tr>
                {onSelect && <th>操作</th>}
                {Object.keys(rows[0]).map((key) => (
                  <th key={key}>
                    {(
                      {
                        id: "编号",
                        email: "邮箱",
                        name: "名称",
                        role: "角色",
                        enabled: "启用",
                        limits: "个人额度",
                        created_at: "创建时间",
                        expires_at: "失效时间",
                        lastSeen: "最近活动",
                        createdAt: "创建时间",
                        expiresAt: "失效时间",
                        actor: "操作者",
                        action: "操作",
                        target: "对象",
                        detail: "详情",
                        call_key: "调用编号",
                        user_id: "用户",
                        scope: "任务或评分",
                        kind: "调用类型",
                        day: "日期",
                        record: "回执",
                      } as Record<string, string>
                    )[key] ?? key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={String(row.id ?? row.call_key ?? i)}>
                  {onSelect && <td><Button variant="outline" onClick={() => onSelect(row)}>选择</Button></td>}
                  {Object.entries(row).map(([key, value]) => (
                    <td key={key}>
                      {value !== null && typeof value === "object" ? (
                        <details>
                          <summary>查看详情</summary>
                          <pre>{JSON.stringify(value, null, 2)}</pre>
                        </details>
                      ) : (
                        typeof value === 'boolean' ? (value ? '已启用' : '已停用') : key === 'role' ? (value === 'admin' ? '管理员' : '普通用户') : /^(created_at|expires_at|createdAt|expiresAt|lastSeen)$/.test(key) && value ? new Date(String(value)).toLocaleString('zh-CN', { hour12: false }) : String(value ?? '—')
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {paginated && <nav aria-label="记录分页"><Button variant="outline" disabled={!offset} onClick={() => setOffset(v => Math.max(0, v - 100))}>上一页</Button><Button variant="outline" disabled={rows.length < 100} onClick={() => setOffset(v => v + 100)}>下一页</Button></nav>}
    </>
  );
}
