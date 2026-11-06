import { lazy, Suspense, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type {
  AccountUsage,
  AccountSession,
  AccountUser,
  AccountLimits,
  AdministrationSettings,
  DocumentTaskDetail,
  DocumentTaskReview,
  DocumentTaskList,
} from "./contracts.generated";
import { accountRequest as request, setAccount } from "./accountClient";
import { Client } from "./api";
import { ImportSettingsPanel } from "./ImportSettingsPanel";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import logo from "./assets/octopus.png";
const Workspace = lazy(() => import("./App"));
const Review = lazy(() => import("./ResultReview"));
const messages: Record<string, string> = {
  INVALID_CREDENTIALS: "邮箱或密码错误，或账户已停用。",
  CSRF_INVALID: "页面凭证已过期，请刷新后手动重试。",
  AUTH_RATE_LIMITED: "操作过于频繁，请稍后再试。",
  EMAIL_UNAVAILABLE: "此邮箱无法使用。",
  LAST_ADMIN: "必须保留至少一位有效管理员。",
  PASSWORD_REQUIRED: "请核对当前密码。",
  RESET_EXPIRED: "重置链接已失效，请联系管理员重新生成。",
};
const errorMessage = (e: unknown) =>
  e instanceof Error
    ? (messages[e.message] ?? e.message)
    : "操作失败，请刷新核对状态后再决定是否重试。";
function Field({
  name,
  label,
  type = "text",
  value,
  onChange,
  min,
  max,
}: {
  name: string;
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
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
        min={min}
        max={max}
        minLength={type === "password" ? 1 : undefined}
        maxLength={type === "password" ? 128 : 254}
        autoComplete={
          type === "password"
            ? "current-password"
            : type === "email"
              ? "email"
              : "off"
        }
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
function Form({
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
function Records({ path, refresh = 0, onSelect, paginated = false }: { path: string; refresh?: number; onSelect?: (row: Record<string, unknown>) => void; paginated?: boolean }) {
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void request<Record<string, unknown>[]>(
      paginated ? `${path}${path.includes("?") ? "&" : "?"}offset=${offset}` : path,
      "GET",
      undefined,
      controller.signal,
    )
      .then(setRows)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [path, refresh, paginated, offset]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {!rows.length && !error && <p>暂无记录。</p>}
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
function AccountSettings({ user, onNameSaved }: { user: AccountUser; onNameSaved: (name: string) => void }) {
  const [password, setPassword] = useState(""),
    [email, setEmail] = useState(""),
    [name, setName] = useState(user.name),
    [newPassword, setNewPassword] = useState(""),
    [token, setToken] = useState(""),
    [tokenName, setTokenName] = useState("macOS App"),
    [revoke, setRevoke] = useState(""),
    [revision, setRevision] = useState(0);
  return (
    <>
      <h1>账户与安全</h1>
      <p>邮箱暂不验证，仅作为登录标识。忘记密码请联系管理员。</p>
      <Form
        label="保存账户信息"
        submit={async () => {
          await request("/api/me/profile", "PATCH", {
            currentPassword: password,
            name,
            ...(email ? { email } : {}),
            ...(newPassword ? { password: newPassword } : {}),
          });
          setPassword("");
          if (email || newPassword)
            window.dispatchEvent(new Event("practiq-session-expired"));
          else onNameSaved(name);
        }}
      >
        <Field
          name="current-password"
          label="当前密码"
          type="password"
          value={password}
          onChange={setPassword}
        />
        <label className="account-field">
          昵称
          <Input
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="account-field">
          新登录邮箱（可选）
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="account-field">
          新密码（可选，至少 12 字符）
          <Input
            type="password"
            minLength={12}
            maxLength={128}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </label>
      </Form>
      <h2>App 评分连接</h2>
      <p>
        令牌仅允许连接检查和显式评分，有效期 90 天。复制到 macOS App
        的服务连接设置，凭证由 Keychain 保存。
      </p>
      <Form
        label="创建个人评分令牌"
        submit={async () => {
          setToken("");
          const result = await request<{ token: string }>(
            "/api/me/tokens",
            "POST",
            { currentPassword: password, name: tokenName },
          );
          setToken(result.token);
          setPassword("");
          setRevision((v) => v + 1);
        }}
      >
        <Field
          name="token-password"
          label="当前密码"
          type="password"
          value={password}
          onChange={setPassword}
        />
        <Field
          name="token-name"
          label="连接名称"
          value={tokenName}
          onChange={setTokenName}
        />
      </Form>
      {token && (
        <div className="notice">
          <p>令牌仅展示本次，请立即复制。离开页面后无法再次查看。</p>
          <Input aria-label="新评分令牌" readOnly value={token} />
          <Button variant="outline" onClick={() => setToken("")}>
            隐藏令牌
          </Button>
        </div>
      )}
      <Records path="/api/me/tokens" refresh={revision} onSelect={row => setRevoke(String(row.id))} />
      <Form
        label="撤销指定令牌"
        submit={async () => {
          await request(
            `/api/me/tokens/${encodeURIComponent(revoke)}`,
            "DELETE",
          );
          setRevision((v) => v + 1);
        }}
      >
        <Field
          name="revoke-token"
          label="令牌编号"
          value={revoke}
          onChange={setRevoke}
        />
      </Form>
      <h2>登录会话</h2>
      <Records path="/api/me/sessions" refresh={revision} onSelect={row => setRevoke(String(row.id))} />
      <Form
        label="撤销指定会话"
        submit={async () => {
          await request(
            `/api/me/sessions/${encodeURIComponent(revoke)}`,
            "DELETE",
          );
          setRevision((v) => v + 1);
        }}
      >
        <Field
          name="revoke-session"
          label="会话编号"
          value={revoke}
          onChange={setRevoke}
        />
      </Form>
    </>
  );
}
function Usage() {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<AccountUsage | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void request<typeof data>(
      `/api/me/usage?offset=${offset}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [offset]);
  return (
    <>
      <h1>个人用量</h1>
      <p>
        新账户默认共有 50 页免费识别额度，累计使用，不按日恢复。未知结果仍保留预留页数；读取已保存结果不重复扣减。
      </p>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p role="status">免费识别额度：剩余 {data.remainingPages} / {data.limits.freePages} 页，已使用或预留 {data.usedPages} 页。</p>
          {data.remainingPages === 0 && <p className="notice">免费页数已用尽。请联系管理员调整额度；已保存的结果仍可查看和下载。</p>}
          <p>
            每日模型 {data.limits.modelCalls} 次 · 腾讯提交{" "}
            {data.limits.tencentCalls} 次 · 进行中任务 {data.limits.activeTasks}{" "}
            个
          </p>
          <p>每日调用次数按新加坡时间零点重置，免费页数不重置。任务暂停后需要手动继续。</p>
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>调用类型</th>
                <th>次数</th>
              </tr>
            </thead>
            <tbody>
              {data.daily.map((r) => (
                <tr key={r.day + r.kind}>
                  <td>{r.day}</td>
                  <td>{r.kind === "modelCalls" ? "模型调用" : "腾讯提交"}</td>
                  <td>{r.calls}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>调用记录</h2>
          <div className="account-table"><table><thead><tr><th scope="col">日期</th><th scope="col">类型</th><th scope="col">用量状态</th><th scope="col">输入 / 输出 tokens</th></tr></thead><tbody>{data.calls.map(call => <tr key={call.call_key}><td>{call.day}</td><td>{call.kind === 'modelCalls' ? '模型调用' : '腾讯提交'}</td><td>{call.kind === 'tencentCalls' ? (call.record.taskId ? '已确认提交' : '提交结果未知') : call.record.usageStatus === 'known' ? '已知用量' : '未知用量'}</td><td>{call.kind === 'tencentCalls' ? '—' : `${typeof call.record.inputTokens === 'number' ? call.record.inputTokens : '未知'} / ${typeof call.record.outputTokens === 'number' ? call.record.outputTokens : '未知'}`}</td></tr>)}</tbody></table></div>
          <details>
            <summary>最近调用回执（包含未知结果）</summary>
            <pre>{JSON.stringify(data.calls, null, 2)}</pre>
          </details>
        </>
      )}
      <nav aria-label="调用记录分页"><Button variant="outline" disabled={!offset} onClick={() => setOffset(v => Math.max(0, v - 100))}>上一页</Button><Button variant="outline" disabled={!data || data.calls.length < 100} onClick={() => setOffset(v => v + 100)}>下一页</Button></nav>
    </>
  );
}
function Banks({ open }: { open: (id: string) => void }) {
  const [data, setData] = useState<DocumentTaskList | null>(null),
    [offset, setOffset] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void request<DocumentTaskList>(
      `/api/me/banks?offset=${offset}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [offset]);
  return (
    <>
      <h1>我的题库</h1>
      <p>查看保存的解析结果、复核内容并下载题库 ZIP。下载不启动模型。</p>
      {error && <p role="alert">{error}</p>}
      {data?.items.length === 0 && <p>尚无已保存结果，请先导入文档。</p>}
      {data?.items.map((task) => (
        <section className="account-bank" key={task.threadId}>
          <div>
            <h2>{task.fileName}</h2>
            <p>
              {task.questionCount} 道题 · {task.reviewCount} 道待复核 · 有效至{" "}
              {task.expiresAt}
            </p>
          </div>
          <Button onClick={() => open(task.threadId)}>查看结果与下载</Button>
        </section>
      ))}
      <Button
        variant="outline"
        disabled={!offset}
        onClick={() => setOffset((v) => Math.max(0, v - 50))}
      >
        上一页
      </Button>
      <Button
        variant="outline"
        disabled={!data?.hasMore}
        onClick={() => setOffset((v) => v + 50)}
      >
        下一页
      </Button>
    </>
  );
}
function AdminSettings() {
  const [executionClient] = useState(() => new Client(true));
  const [value, setValue] = useState<AdministrationSettings | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    void request<AdministrationSettings>("/api/admin/settings")
      .then(setValue)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  return (
    <>
      <h1>注册与默认额度</h1>
      {error && <p role="alert">{error}</p>}
      {value && (
        <Form
          label="保存系统设置"
          submit={async () => {
            setValue(await request("/api/admin/settings", "PUT", value));
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={value.registrationEnabled}
              onChange={(e) =>
                setValue({ ...value, registrationEnabled: e.target.checked })
              }
            />
            允许公开注册
          </label>
          {(["freePages", "modelCalls", "tencentCalls", "activeTasks"] as const).map(
            (key) => (
              <Field
                key={key}
                name={key}
                label={
                  {
                    freePages: "新账户免费页数（一次性累计）",
                    modelCalls: "每日模型调用数",
                    tencentCalls: "每日腾讯提交数",
                    activeTasks: "进行中任务数",
                  }[key]
                }
                type="number"
                min={key === "activeTasks" ? 1 : 0}
                value={String(value[key])}
                onChange={(v) => setValue({ ...value, [key]: Number(v) })}
              />
            ),
          )}
        </Form>
      )}
      <h2>识别执行参数</h2>
      <ImportSettingsPanel client={executionClient} />
    </>
  );
}
function AdminUsers() {
  const [defaults, setDefaults] = useState<AccountLimits | null>(null),
    [defaultsError, setDefaultsError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void request<AdministrationSettings>("/api/admin/settings", "GET", undefined, controller.signal)
      .then(setDefaults)
      .catch(error => { if (!controller.signal.aborted) setDefaultsError(errorMessage(error)); });
    return () => controller.abort();
  }, []);
  const [id, setId] = useState(""),
    [password, setPassword] = useState(""),
    [enabled, setEnabled] = useState(true),
    [role, setRole] = useState<"user" | "admin">("user"),
    [limits, setLimits] = useState<AccountLimits>({
      freePages: 50,
      modelCalls: 1000,
      tencentCalls: 50,
      activeTasks: 2,
    }),
    [override, setOverride] = useState(false),
    [link, setLink] = useState(""),
    [revision, setRevision] = useState(0),
    [offset, setOffset] = useState(0);
  return (
    <>
      <h1>用户管理</h1>
      {defaultsError && <p role="alert">{defaultsError}</p>}
      {!defaults && !defaultsError && <p role="status">正在读取默认额度…</p>}
      <Records path={`/api/admin/users?offset=${offset}`} refresh={revision} onSelect={defaults ? row => {
        setId(String(row.id)); setEnabled(row.enabled === true); setRole(row.role === 'admin' ? 'admin' : 'user');
        const saved = row.limits as Partial<AccountLimits>; setOverride(Object.keys(saved).length > 0);
        setLimits({ freePages: saved.freePages ?? defaults.freePages, modelCalls: saved.modelCalls ?? defaults.modelCalls, tencentCalls: saved.tencentCalls ?? defaults.tencentCalls, activeTasks: saved.activeTasks ?? defaults.activeTasks });
      } : undefined} />
      <Button
        variant="outline"
        disabled={!offset}
        onClick={() => setOffset((v) => Math.max(0, v - 50))}
      >
        上一页
      </Button>
      <Button variant="outline" onClick={() => setOffset((v) => v + 50)}>
        下一页
      </Button>
      {id && <>
      <h2>编辑选中的用户</h2>
      <Form
        label="更新指定用户"
        submit={async () => {
          await request(`/api/admin/users/${encodeURIComponent(id)}`, "PATCH", {
            currentPassword: password,
            enabled,
            role,
            limits: override ? limits : null,
          });
          setPassword("");
          setRevision((v) => v + 1);
        }}
      >
        <Field name="user-id" label="用户编号" value={id} onChange={setId} />
        <Field
          name="admin-password"
          label="管理员当前密码"
          type="password"
          value={password}
          onChange={setPassword}
        />
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用账户（停用将撤销凭证并阻止后续付费调用）
        </label>
        <label>
          角色
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "user" | "admin")}
          >
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
          />
          覆盖默认额度
        </label>
        {override &&
          (["freePages", "modelCalls", "tencentCalls", "activeTasks"] as const).map(
            (key) => (
              <Field
                key={key}
                name={`limit-${key}`}
                label={
                  {
                    freePages: "免费页数总额度（含已用页数）",
                    modelCalls: "每日模型调用数",
                    tencentCalls: "每日腾讯提交数",
                    activeTasks: "进行中任务数",
                  }[key]
                }
                type="number"
                min={key === "activeTasks" ? 1 : 0}
                value={String(limits[key])}
                onChange={(v) => setLimits({ ...limits, [key]: Number(v) })}
              />
            ),
          )}
      </Form>
      <Form
        label="生成一次性重置链接"
        submit={async () => {
          setLink("");
          const result = await request<{ path: string }>(
            `/api/admin/users/${encodeURIComponent(id)}/reset-link`,
            "POST",
            { currentPassword: password },
          );
          setLink(location.origin + result.path);
          setPassword("");
        }}
      >
        <Field
          name="reset-user-id"
          label="用户编号"
          value={id}
          onChange={setId}
        />
        <Field
          name="reset-admin-password"
          label="管理员当前密码"
          type="password"
          value={password}
          onChange={setPassword}
        />
        <p>
          先通过外部渠道核实身份。链接 30
          分钟有效，仅展示本次，访问链接本身不重置密码。
        </p>
      </Form>
      {link && <Input aria-label="一次性重置链接" readOnly value={link} />}
      </>}
    </>
  );
}
function AdminTasks() {
  const [client] = useState(() => new Client(true)),
    [tasks, setTasks] = useState<DocumentTaskList | null>(null),
    [detail, setDetail] = useState<DocumentTaskDetail | null>(null),
    [preview, setPreview] = useState<DocumentTaskReview | null>(null),
    [id, setId] = useState(""),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(0);
  async function read() {
    setError("");
    try {
      setTasks(await client.list(offset));
      if (id) {
        setPreview(null);
        setDetail(await client.detail(id));
        setPreview(await client.preview(id));
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <>
      <h1>任务检查与恢复</h1>
      <p>
        跨用户检查与操作将被审计。恢复可能再次产生费用，并计入任务所属用户额度。
      </p>
      <Form label="读取任务" submit={read}>
        <label className="account-field">
          任务编号（留空读取列表）
          <Input
            value={id}
            onChange={(e) => {
              setId(e.target.value);
              setDetail(null);
              setPreview(null);
            }}
          />
        </label>
      </Form>
      {error && <p role="alert">{error}</p>}
      {tasks?.items.map((task) => (
        <div className="account-bank" key={task.threadId}>
          <span>
            {task.fileName} · {task.state}
          </span>
          <Button
            variant="outline"
            onClick={() => {
              setId(task.threadId);
              setDetail(null);
              setPreview(null);
            }}
          >
            {task.threadId}
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        disabled={!offset}
        onClick={() => setOffset((v) => Math.max(0, v - 20))}
      >
        上一页
      </Button>
      <Button
        variant="outline"
        disabled={!tasks?.hasMore}
        onClick={() => setOffset((v) => v + 20)}
      >
        下一页
      </Button>
      {detail && (
        <>
          <h2>{detail.fileName}</h2>
          <p>
            {detail.state} · {detail.status}
          </p>
          <details>
            <summary>调用与阻塞原因</summary>
            <pre>
              {JSON.stringify(
                {
                  usage: detail.usage,
                  unknown: detail.unknownUsageCalls,
                  blocking: detail.blocking,
                },
                null,
                2,
              )}
            </pre>
          </details>
          {detail.allowedActions.map((action) => (
            <Button
              key={action}
              variant="outline"
              onClick={() => {
                if (
                  window.confirm(`确认执行 ${action}？继续或重试可能产生费用。`)
                )
                  void client
                    .control(detail, action)
                    .then(read)
                    .catch((e) => setError(errorMessage(e)));
              }}
            >
              {action}
            </Button>
          ))}
          {preview && (
            <Suspense fallback={<p>正在载入结果…</p>}>
              <Review client={client} preview={preview} task={detail} />
            </Suspense>
          )}
        </>
      )}
    </>
  );
}
export default function AccountPortal() {
  const [focusMain, setFocusMain] = useState(false);
  const [account, updateAccount] = useState<AccountSession | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [page, setPage] = useState("workspace"),
    [adminPage, setAdminPage] = useState("users"),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [resetToken] = useState(() =>
      location.pathname === "/reset-password" ? location.hash.slice(1) : "",
    ),
    [task, setTask] = useState<string>();
  const admin = location.pathname === "/admin";
  const register = location.pathname === "/register";
  const reset = location.pathname === "/reset-password";
  useEffect(() => {
    if (reset) history.replaceState(null, "", "/reset-password");
    let controller = new AbortController();
    async function load() {
      controller.abort();
      const current = new AbortController();
      controller = current;
      setLoading(true);
      setAccount(null);
      updateAccount(null);
      try {
        const result = await request<AccountSession>(
          "/api/auth/session",
          "GET",
          undefined,
          current.signal,
        );
        if (!current.signal.aborted) {
          setAccount(result);
          updateAccount(result);
        }
      } catch (e) {
        if (!current.signal.aborted) setError(errorMessage(e));
      } finally {
        if (!current.signal.aborted) setLoading(false);
      }
    }
    void load();
    const expired = () => {
      setAccount(null);
      updateAccount(null);
      setError("登录已失效，请重新登录。");
      void load();
    };
    const changed = () => {
      void load();
    };
    window.addEventListener("practiq-session-expired", expired);
    const channel = new BroadcastChannel("practiq-account");
    channel.onmessage = changed;
    return () => {
      controller.abort();
      channel.close();
      window.removeEventListener("practiq-session-expired", expired);
      setAccount(null);
    };
  }, [reset]);
  function signedIn(value: AccountSession) {
    setAccount(value);
    updateAccount(value);
    const channel = new BroadcastChannel("practiq-account");
    channel.postMessage("changed");
    channel.close();
    location.assign("/");
  }
  const user: AccountUser | null = account?.user ?? null;
  const content = loading ? (
    <p role="status">正在读取登录状态…</p>
  ) : !user || reset ? (
    <section className="account-auth">
      <h1>{reset ? "重置密码" : register ? "注册 PractiQ" : "登录 PractiQ"}</h1>
      {error && <p role="alert">{error}</p>}
      {register && account && !account.registrationEnabled && <p role="status">公开注册暂未开放，请联系管理员。</p>}
      {account && (!register || account.registrationEnabled) && (
        <Form
          label={reset ? "设置新密码" : register ? "注册并登录" : "登录"}
          submit={async () => {
            if (reset) {
              await request("/api/auth/reset-password", "POST", {
                token: resetToken,
                password,
              });
              location.assign("/login");
            } else {
              signedIn(
                await request<AccountSession>(
                  register ? "/api/auth/register" : "/api/auth/login",
                  "POST",
                  { email, password },
                ),
              );
            }
          }}
        >
          {!reset && (
            <Field
              name="login-email"
              label="登录邮箱"
              type="email"
              value={email}
              onChange={setEmail}
            />
          )}
          <label className="account-field">
            {reset || register ? "密码（至少 12 字符）" : "密码"}
            <Input
              name="password"
              type="password"
              autoComplete={
                reset || register ? "new-password" : "current-password"
              }
              minLength={12}
              maxLength={128}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </Form>
      )}
      <p>忘记密码请联系管理员核实身份，获取一次性重置链接。</p>
      <a href="/login">登录</a>
      {account?.registrationEnabled && (
        <>
          {" "}
          · <a href="/register">注册账户</a>
        </>
      )}
    </section>
  ) : admin ? (
    user.role !== "admin" ? (
      <p role="alert">没有管理权限。</p>
    ) : (
      <div className="account-layout">
        <nav aria-label="管理导航">
          {[
            ["users", "用户"],
            ["tasks", "任务"],
            ["usage", "提供商用量"],
            ["settings", "系统设置"],
            ["audit", "审计"],
          ].map(([id, label]) => (
            <Button
              key={id}
              variant={adminPage === id ? "secondary" : "ghost"}
              onClick={() => setAdminPage(id)}
            >
              {label}
            </Button>
          ))}
        </nav>
        <main className="account-content" key={adminPage}>
          {adminPage === "users" ? (
            <AdminUsers />
          ) : adminPage === "tasks" ? (
            <AdminTasks />
          ) : adminPage === "settings" ? (
            <AdminSettings />
          ) : (
            <>
              <h1>{adminPage === "audit" ? "审计记录" : "提供商调用记录"}</h1>
              <Records path={`/api/admin/${adminPage}`} paginated />
            </>
          )}
        </main>
      </div>
    )
  ) : (
    <>
      <nav className="account-navigation" aria-label="个人导航">
        {[
          ["workspace", "导入工作区"],
          ["banks", "我的题库"],
          ["usage", "用量"],
          ["account", "账户与安全"],
        ].map(([id, label]) => (
          <Button
            key={id}
            variant={page === id ? "secondary" : "ghost"}
            onClick={() => setPage(id)}
          >
            {label}
          </Button>
        ))}
      </nav>
      <div key={user.id}>
        <div hidden={page !== "workspace"}>
          <Suspense fallback={<p>正在载入工作区…</p>}>
            <Workspace key={task ?? "default"} initialTaskId={task} hideSkipLink focusMain={focusMain} />
          </Suspense>
        </div>
        {page !== "workspace" && (
          <main className="account-content">
            {page === "banks" ? (
              <Banks
                open={(id) => {
                  setTask(id);
                  location.hash = "records";
                  setPage("workspace");
                }}
              />
            ) : page === "usage" ? (
              <Usage />
            ) : (
              <AccountSettings user={user} onNameSaved={name => { if (account) { const updated = { ...account, user: { ...user, name } }; setAccount(updated); updateAccount(updated); } }} />
            )}
          </main>
        )}
      </div>
    </>
  );
  return (
    <>
      {user && !admin && page === "workspace" && <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); setFocusMain(true); const main = document.getElementById("main-content"); if (main) { main.focus(); main.scrollIntoView(); } }}>跳到主要内容</a>}
      <header className="account-header">
        <a href="/">
          <img src={logo} alt="" />
          PractiQ {admin ? "管理" : "用户门户"}
        </a>
        {user && (
          <>
            <span>{user.name || user.email}</span>
            {user.role === "admin" && (
              <a href={admin ? "/" : "/admin"}>{admin ? "用户区" : "管理区"}</a>
            )}
            <Button
              variant="outline"
              onClick={() =>
                void request("/api/auth/logout", "POST")
                  .then(() => {
                    setAccount(null);
                    updateAccount(null);
                    const channel = new BroadcastChannel("practiq-account");
                    channel.postMessage("changed");
                    channel.close();
                    location.assign("/login");
                  })
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              退出登录
            </Button>
          </>
        )}
      </header>
      {user && error && <p role="alert">{error}</p>}
      {content}
    </>
  );
}
