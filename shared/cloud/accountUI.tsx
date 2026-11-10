import { cloudLocale, t, useCloudLocale } from "./i18n";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { accountRequest as request } from "./accountClient";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { CircleAlert } from "lucide-react";
const messages: Record<string, string> = {
  "Failed to fetch": "无法连接服务。请检查服务状态，再手动重试读取。",
  "Load failed": "无法连接服务。请检查服务状态，再手动重试读取。",
  "Network request failed": "无法连接服务。请检查服务状态，再手动重试读取。",
  ALLOWANCE_CHANGED: "额度已被其他操作更新，请重新选择用户以读取最新额度，再决定是否调整。",
  ALLOWANCE_REASON_REQUIRED: "修改免费总额度需要填写调整原因。",
  CREDENTIAL_NOT_FOUND: "该凭证已失效或不属于所选用户，请重新读取凭证列表。",
  USER_NOT_FOUND: "未找到该用户，请重新搜索并选择用户。",

  PLAN_REFUND_REQUIRES_UNUSED_FULL_ORDER: "套餐与加量包仅支持未使用、未预留额度的整单退款。请核对订单的实际付款金额及额度明细。",
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
    ? (t(messages[e.message] ?? e.message))
    : t("操作失败，请刷新核对状态后再决定是否重试。");
export function AccountError({ error, retry }: { error: string; retry?: () => void }) {
  useCloudLocale();
  const diagnostic = /^[A-Z][A-Z0-9_]+$/.test(error) || /^(请求失败|請求失敗|Request failed) \(\d+\)$/.test(error);
  return <div role="alert" className="error-banner account-error">
    <CircleAlert size={18} className="shrink-0" aria-hidden="true" />
    <div><p>{diagnostic ? t("请求未完成，请核对状态后再决定是否重试。") : error}</p>
      {diagnostic && <details><summary>{t("诊断详情")}</summary><pre>{error}</pre></details>}
    </div>
    {retry && <Button type="button" variant="outline" onClick={retry}>{t("重试读取")}</Button>}
  </div>;
}
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
  useCloudLocale();
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
  useCloudLocale();
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
        <Button type="submit">{busy ? t("正在处理…") : label}</Button>
      </fieldset>
      {error && <AccountError error={error} />}
      {saved && <p role="status">{t("操作已完成。")}</p>}
    </form>
  );
}
export function Records({ path, refresh = 0, onSelect, paginated = false }: { path: string; refresh?: number; onSelect?: (row: Record<string, unknown>) => void; paginated?: boolean }) {
  useCloudLocale();
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
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
  }, [path, refresh, paginated, offset, revision]);
  return (
    <>
      {error && <AccountError error={error} retry={() => setRevision(v => v + 1)} />}
      {loading && <p role="status">{t("正在读取记录…")}</p>}
      {!loading && !rows.length && !error && <p>{t("暂无记录。")}</p>}
      {!!rows.length && (
        <div className="account-table">
          <table>
            <thead>
              <tr>
                {onSelect && <th>{t("操作")}</th>}
                {Object.keys(rows[0]).map((key) => (
                  <th key={key}>
                    {(
                      {
                        id: t("编号"),
                        email: t("邮箱"),
                        name: t("名称"),
                        role: t("角色"),
                        enabled: t("启用"),
                        limits: t("个人额度"),
                        created_at: t("创建时间"),
                        expires_at: t("失效时间"),
                        lastSeen: t("最近活动"),
                        createdAt: t("创建时间"),
                        expiresAt: t("失效时间"),
                        actor: t("操作者"),
                        action: t("操作"),
                        target: t("对象"),
                        detail: t("详情"),
                        call_key: t("调用编号"),
                        user_id: t("用户"),
                        scope: t("任务或评分"),
                        kind: t("调用类型"),
                        day: t("日期"),
                        record: t("回执"),
                      } as Record<string, string>
                    )[key] ?? key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={String(row.id ?? row.call_key ?? i)}>
                  {onSelect && <td><Button variant="outline" onClick={() => onSelect(row)}>{t("选择")}</Button></td>}
                  {Object.entries(row).map(([key, value]) => (
                    <td key={key}>
                      {value !== null && typeof value === "object" ? (
                        <details>
                          <summary>{t("查看详情")}</summary>
                          <pre>{JSON.stringify(value, null, 2)}</pre>
                        </details>
                      ) : (
                        typeof value === 'boolean' ? (value ? t("已启用") : t("已停用")) : key === 'role' ? (value === 'admin' ? t("管理员") : t("普通用户")) : /^(created_at|expires_at|createdAt|expiresAt|lastSeen)$/.test(key) && value ? new Date(String(value)).toLocaleString(cloudLocale(), { hour12: false }) : String(value ?? '—')
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {paginated && <nav aria-label={t("记录分页")}><Button variant="outline" disabled={!offset} onClick={() => setOffset(v => Math.max(0, v - 100))}>{t("上一页")}</Button><Button variant="outline" disabled={rows.length < 100} onClick={() => setOffset(v => v + 100)}>{t("下一页")}</Button></nav>}
    </>
  );
}
