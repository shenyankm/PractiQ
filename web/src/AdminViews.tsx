import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { AdministrationSettings, AccountLimits, DocumentTaskDetail, DocumentTaskReview, DocumentTaskList } from "./contracts.generated";
import { accountRequest as request } from "../../shared/cloud/accountClient";
import { Field, Form, Records, errorMessage } from "../../shared/cloud/accountUI";
import { Client } from "../../shared/cloud/api";
import { ImportSettingsPanel } from "../../shared/cloud/ImportSettingsPanel";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
const Review = lazy(() => import("../../shared/cloud/ResultReview"));
export function AdminSettings() {
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
export function AdminUsers() {
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
    [link, setLink] = useState<{userId:string;url:string} | null>(null),
    [revision, setRevision] = useState(0),
    [offset, setOffset] = useState(0);
  return (
    <>
      <h1>用户管理</h1>
      {defaultsError && <p role="alert">{defaultsError}</p>}
      {!defaults && !defaultsError && <p role="status">正在读取默认额度…</p>}
      <Records path={`/api/admin/users?offset=${offset}`} refresh={revision} onSelect={defaults ? row => {
        setId(String(row.id)); setEnabled(row.enabled === true); setRole(row.role === 'admin' ? 'admin' : 'user');
        setPassword(""); setLink(null);
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
        key={`update-${id}`}
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
        <Field name="user-id" label="用户编号" value={id} onChange={setId} readOnly />
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
        key={`reset-${id}`}
        label="生成一次性重置码"
        submit={async () => {
          setLink(null);
          const result = await request<{ path: string }>(
            `/api/admin/users/${encodeURIComponent(id)}/reset-link`,
            "POST",
            { currentPassword: password },
          );
          setLink({userId:id,url:result.path.split("#")[1] || ""});
          setPassword("");
        }}
      >
        <Field
          name="reset-user-id"
          label="用户编号"
          value={id}
          onChange={setId}
          readOnly
        />
        <Field
          name="reset-admin-password"
          label="管理员当前密码"
          type="password"
          value={password}
          onChange={setPassword}
        />
        <p>
          先通过外部渠道核实身份。重置码 30 分钟有效，仅展示本次。请让用户在 App 的登录页选择重置密码并粘贴此码。
        </p>
      </Form>
      {link?.userId === id && <Input aria-label="一次性重置码" readOnly value={link.url} />}
      </>}
    </>
  );
}
export function AdminTasks() {
  const [client] = useState(() => new Client(true)),
    [tasks, setTasks] = useState<DocumentTaskList | null>(null),
    [detail, setDetail] = useState<DocumentTaskDetail | null>(null),
    [preview, setPreview] = useState<DocumentTaskReview | null>(null),
    [id, setId] = useState(""),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(0);
  const selectedId = useRef(""), pageOffset = useRef(0);
  const listRequest = useRef<AbortController | null>(null), detailRequest = useRef<AbortController | null>(null);
  const readPage = useCallback(async (nextOffset: number) => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    pageOffset.current = nextOffset;
    setOffset(nextOffset);
    setTasks(null);
    setError("");
    try {
      const result = await client.list(nextOffset, "", controller.signal);
      if (!controller.signal.aborted) setTasks(result);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }, [client]);
  useEffect(() => {
    void readPage(0).catch(error => setError(errorMessage(error)));
    return () => { listRequest.current?.abort(); detailRequest.current?.abort(); };
  }, [readPage]);
  function selectId(value: string) {
    selectedId.current = value;
    detailRequest.current?.abort();
    setId(value);
    setDetail(null);
    setPreview(null);
    setError("");
  }
  async function readDetail(target = selectedId.current) {
    if (!target || selectedId.current !== target) return;
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setDetail(null);
    setPreview(null);
    try {
      await Promise.all([
        client.detail(target, controller.signal).then(current => {
          if (!controller.signal.aborted && selectedId.current === target) setDetail(current);
        }),
        client.preview(target, controller.signal).then(review => {
          if (!controller.signal.aborted && selectedId.current === target) setPreview(review);
        }),
      ]);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }
  async function read() {
    setError("");
    await readPage(pageOffset.current);
    await readDetail();
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
            onChange={(e) => selectId(e.target.value)}
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
              selectId(task.threadId);
              void readDetail(task.threadId).catch(error => setError(errorMessage(error)));
            }}
          >
            {task.threadId}
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        disabled={!offset}
        onClick={() => { void readPage(Math.max(0, offset - 20)).catch(error => setError(errorMessage(error))); }}
      >
        上一页
      </Button>
      <Button
        variant="outline"
        disabled={!tasks?.hasMore}
        onClick={() => { void readPage(offset + 20).catch(error => setError(errorMessage(error))); }}
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
