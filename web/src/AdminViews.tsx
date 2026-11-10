import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { AdministrationSettings, AdministrationFilter, AdministrationTaskList, AccountLimits, DocumentTaskDetail, DocumentTaskReview } from "./contracts.generated";
import { accountRequest as request } from "../../shared/cloud/accountClient";
import { AccountError, Field, Form, Records, errorMessage } from "../../shared/cloud/accountUI";
import { Client } from "../../shared/cloud/api";
import { ImportSettingsPanel } from "../../shared/cloud/ImportSettingsPanel";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { FilterBar, Pagination, query, type AdminNavigate } from "./adminTools";
import { Dialog } from "radix-ui";
import { AdminUserDetails } from "./AdminUserDetails";
import { Select, SelectOption } from "./components/ui/select";
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
      <h1>系统设置</h1>
      <div className="admin-system-settings">
      {error && <AccountError error={error} />}
      {value && (
        <section className="admin-registration" aria-labelledby="registration-settings-heading">
          <h2 id="registration-settings-heading">注册与默认额度</h2>
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
                      freePages: "新账户免费页数",
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
        </section>
      )}
      <ImportSettingsPanel client={executionClient} />
      </div>
    </>
  );
}
export function AdminUsers({ initial = {}, initialId = "", navigate }: { initial?: AdministrationFilter; initialId?: string; navigate: AdminNavigate }) {
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const [filters, setFilters] = useState<AdministrationFilter>(initial);
  const [reason, setReason] = useState(""), [baselineFree, setBaselineFree] = useState(50), [editing, setEditing] = useState(false);
  const [defaults, setDefaults] = useState<AccountLimits | null>(null),
    [defaultsError, setDefaultsError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void request<AdministrationSettings>("/api/admin/settings", "GET", undefined, controller.signal)
      .then(setDefaults)
      .catch(error => { if (!controller.signal.aborted) setDefaultsError(errorMessage(error)); });
    return () => controller.abort();
  }, []);
  const [id, setId] = useState(initialId),
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
    [offset, setOffset] = useState(0), [rowCount, setRowCount] = useState(0);
  return (
    <>
      <h1>用户管理</h1>
      <FilterBar kind="users" initial={initial} apply={value => { setFilters(value); setOffset(0); setId(""); setEditing(false); setPassword(""); setLink(null); }} />
      {defaultsError && <AccountError error={defaultsError} />}
      {!defaults && !defaultsError && <p role="status">正在读取默认额度…</p>}
      <Records path={`/api/admin/users?${query(filters, offset)}`} refresh={revision} onCountChange={setRowCount} onDetails={row => { dialogTrigger.current = document.activeElement as HTMLElement; setEditing(false); setId(String(row.id)); setPassword(""); setLink(null); }} onSelect={defaults ? row => {
        dialogTrigger.current = document.activeElement as HTMLElement;
        setEditing(true); setReason(""); setBaselineFree((row.limits as Partial<AccountLimits>).freePages ?? defaults.freePages);
        setId(String(row.id)); setEnabled(row.enabled === true); setRole(row.role === 'admin' ? 'admin' : 'user');
        setPassword(""); setLink(null);
        const saved = row.limits as Partial<AccountLimits>; setOverride(Object.keys(saved).length > 0);
        setLimits({ freePages: saved.freePages ?? defaults.freePages, modelCalls: saved.modelCalls ?? defaults.modelCalls, tencentCalls: saved.tencentCalls ?? defaults.tencentCalls, activeTasks: saved.activeTasks ?? defaults.activeTasks });
      } : undefined} />
      <Pagination offset={offset} size={50} more={rowCount >= 50} change={setOffset} />
      <Dialog.Root open={!!id} onOpenChange={open => { if (!open) { setId(""); setEditing(false); setPassword(""); setLink(null); } }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" /><Dialog.Content onCloseAutoFocus={event => { if (dialogTrigger.current?.isConnected) { event.preventDefault(); dialogTrigger.current.focus(); } }} data-slot="dialog-content" className="admin-user-dialog fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-6xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto bg-popover p-6 text-popover-foreground outline-none">
      <div className="flex items-start justify-between gap-4"><div><Dialog.Title className="text-xl font-semibold">用户信息</Dialog.Title><Dialog.Description className="mt-2 text-sm text-muted-foreground">查看账户、额度和安全信息。</Dialog.Description></div><Dialog.Close asChild><Button variant="outline">关闭</Button></Dialog.Close></div>
      <div className="cloud-portal admin-user-content">
      {id && <AdminUserDetails key={id} id={id} navigate={navigate} changed={() => setRevision(value => value + 1)} />}
      {id && editing && <section className="settings-panel mt-8">
      <h2>编辑选中的用户</h2>
      <Form
        key={`update-${id}`}
        label="更新指定用户"
        submit={async () => {
          try { await request(`/api/admin/users/${encodeURIComponent(id)}`, "PATCH", {
            currentPassword: password,
            reason, expectedFreePages: baselineFree,
            enabled,
            role,
            limits: override ? limits : null,
          });
          setBaselineFree(override ? limits.freePages : defaults!.freePages);
          setRevision((v) => v + 1);
          } finally { setPassword(""); }
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
        <label className="account-field">变更原因<Input required maxLength={200} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用账户
        </label>
        <label className="account-field">
          角色
          <Select aria-label="角色" className="w-full"
            value={role}
            onValueChange={(value) => setRole(value as "user" | "admin")}
          >
            <SelectOption value="user">普通用户</SelectOption>
            <SelectOption value="admin">管理员</SelectOption>
          </Select>
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
      <div className="border-t border-border pt-6 mt-6">
        <h2>生成一次性重置码</h2>
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
        </Form>
        {link?.userId === id && (
          <div className="mt-4 max-w-sm">
            <Input aria-label="一次性重置码" readOnly value={link.url} />
          </div>
        )}
      </div>
      </section>}
      </div></Dialog.Content></Dialog.Portal></Dialog.Root>
    </>
  );
}
export function AdminTasks({ initial = {}, initialId = "", navigate }: { initial?: AdministrationFilter; initialId?: string; navigate: AdminNavigate }) {
  const [filters, setFilters] = useState<AdministrationFilter>(initial);
  const [client] = useState(() => new Client(true)),
    [tasks, setTasks] = useState<AdministrationTaskList | null>(null),
    [detail, setDetail] = useState<DocumentTaskDetail | null>(null),
    [preview, setPreview] = useState<DocumentTaskReview | null>(null),
    [id, setId] = useState(initialId),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(0);
  const selectedId = useRef(initialId), pageOffset = useRef(0);
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
      const result = await request<AdministrationTaskList>(`/api/admin/task-search?${query(filters, nextOffset)}`, "GET", undefined, controller.signal);
      if (!controller.signal.aborted) setTasks(result);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }, [filters]);
  useEffect(() => {
    void readPage(0).catch(error => setError(errorMessage(error)));
    return () => { listRequest.current?.abort(); };
  }, [readPage]);
  function selectId(value: string) {
    selectedId.current = value;
    detailRequest.current?.abort();
    setId(value);
    setDetail(null);
    setPreview(null);
    setError("");
  }
  const readDetail = useCallback(async (target = selectedId.current) => {
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
  }, [client]);
  useEffect(() => {
    if (initialId) void readDetail(initialId).catch(error => setError(errorMessage(error)));
    return () => detailRequest.current?.abort();
  }, [initialId, readDetail]);
  async function read() {
    setError("");
    await readPage(pageOffset.current);
    await readDetail();
  }
  return (
    <>
      <h1>任务检查与恢复</h1>
      <FilterBar kind="tasks" initial={initial} apply={value => { selectId(""); setFilters(value); }} />
      <Form label="读取任务" submit={read}>
        <label className="account-field">
          任务编号
          <Input
            placeholder="留空读取列表"
            value={id}
            onChange={(e) => selectId(e.target.value)}
          />
        </label>
      </Form>
      {error && <AccountError error={error} />}
      {!tasks && !error && <p role="status">正在读取任务…</p>}
      {tasks && !tasks.items.length && !error && <p role="status" className="account-empty-state">{query(filters) === "offset=0" ? "暂无导入任务。任务创建后将在这里显示。" : "没有匹配的任务，请调整或清除上方筛选。"}</p>}
      {tasks?.items.map((task) => (
        <div className="account-bank" key={task.threadId}>
          <span>
            {task.fileName} · {task.state}
            {task.ownerId && <Button variant="link" onClick={() => navigate("users", {}, task.ownerId!)}>{task.ownerEmail || task.ownerId}</Button>}
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
      <Pagination offset={offset} size={20} more={tasks?.hasMore ?? false} change={next => { void readPage(next).catch(error => setError(errorMessage(error))); }} />
      {detail && (
        <section className="settings-panel mt-8">
          <h2>{detail.fileName}</h2>
          <p className="text-sm text-muted-foreground mb-4">
            {detail.state} · {detail.status}
          </p>
          <details className="mb-4">
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
          <div className="task-actions mb-4">
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
          </div>
          {preview && (
            <Suspense fallback={<p>正在载入结果…</p>}>
              <Review client={client} preview={preview} task={detail} />
            </Suspense>
          )}
        </section>
      )}
    </>
  );
}
