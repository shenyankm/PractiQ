import { useState } from "react";
import { Dialog } from "radix-ui";
import type { AdministrationAudit, AdministrationCall, AdministrationFilter, AdministrationOperations, AdministrationUsageSummary } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Fact, Facts, FilterBar, Pagination, ReadState, auditActions as actions, callStates, dateText, query, useAdminRead, type AdminNavigate } from "./adminTools";

function Scope({ scope, navigate }: { scope: string; navigate: AdminNavigate }) {
  return scope.startsWith("task:") ? <Button variant="link" onClick={() => navigate("tasks", {}, scope.slice(5))}>{scope}</Button> : <span>{scope}</span>;
}
export function AdminUsage({ initial = {}, navigate }: { initial?: AdministrationFilter; navigate: AdminNavigate }) {
  const [filters, setFilters] = useState(initial), [offset, setOffset] = useState(0), [groupsOffset, setGroupsOffset] = useState(0);
  const summary = useAdminRead<AdministrationUsageSummary>(`/api/admin/usage/summary?${query(filters, groupsOffset)}`);
  const calls = useAdminRead<AdministrationCall[]>(`/api/admin/calls?${query(filters, offset)}`);
  const totals = summary.data?.totals;
  return <><div className="section-heading"><h1>提供商调用记录</h1><Button variant="outline" onClick={() => { summary.reload(); calls.reload(); }}>刷新用量</Button></div>
    <FilterBar kind="usage" initial={initial} apply={value => { setFilters(value); setOffset(0); setGroupsOffset(0); }} />
    <ReadState {...summary} retry={summary.reload} />
    {totals && <><Facts><Fact label="筛选范围内调用">{totals.calls} 次</Fact><Fact label="失败 / 未知 / 处理中">{totals.failedCalls} / {totals.unknownCalls} / {totals.pendingCalls} 次</Fact><Fact label="识别已用或预留">{totals.pages} 页</Fact><Fact label="已知输入 / 输出 Token">{totals.inputTokens} / {totals.outputTokens}</Fact><Fact label="Token 信息不完整">{totals.unknownTokenCalls} 次调用</Fact></Facts><p>汇总覆盖全部匹配记录。分组和调用明细分别分页；未知用量不按零用量结算，页数包含保留额度。</p>
    {!!summary.data?.items.length && <div className="account-table"><table><caption>按日期、用户及供应商 / 模型汇总（日期采用调用账本的新加坡日期）</caption><thead><tr><th>日期</th><th>用户</th><th>供应商 / 模型</th><th>调用</th><th>失败 / 未知</th><th>页数</th><th>输入 / 输出 Token</th></tr></thead><tbody>{summary.data.items.map(row => <tr key={[row.day, row.userId, row.kind, row.provider].join("/")}><td>{row.day}</td><td><Button variant="link" onClick={() => navigate("users", {}, row.userId)}>{row.email}</Button></td><td>{row.provider}</td><td className="admin-number">{row.calls}</td><td className="admin-number">{row.failedCalls} / {row.unknownCalls}</td><td className="admin-number">{row.pages}</td><td className="admin-number">{row.inputTokens} / {row.outputTokens}{row.unknownTokenCalls > 0 && <small>另有 {row.unknownTokenCalls} 次信息不完整</small>}</td></tr>)}</tbody></table></div>}
    <Pagination offset={groupsOffset} size={100} more={summary.data?.hasMore ?? false} change={setGroupsOffset} /></>}
    <h2>原始调用回执</h2><ReadState {...calls} retry={calls.reload} />
    {calls.data && !calls.data.length && <p className="account-empty-state">没有匹配的调用记录。</p>}
    {!!calls.data?.length && <div className="account-table"><table><thead><tr><th>调用 / 时间</th><th>用户</th><th>关联任务或评分</th><th>供应商 / 状态</th><th>回执</th></tr></thead><tbody>{calls.data.map(row => <tr key={row.call_key}><td>{row.call_key}<small>{dateText(row.created_at)}</small></td><td><Button variant="link" onClick={() => navigate("users", {}, row.user_id ?? "")}>{row.email}</Button></td><td><Scope scope={row.scope} navigate={navigate} /></td><td>{row.provider}<small>{callStates[row.state]} · {row.status}</small></td><td><details><summary>查看调用回执</summary><pre>{JSON.stringify(row.record, null, 2)}</pre></details></td></tr>)}</tbody></table></div>}
    <Pagination offset={offset} size={100} more={calls.data?.length === 100} change={setOffset} />
  </>;
}
function ChangeDetail({ record, onFilterTarget }: { record: AdministrationAudit; onFilterTarget: () => void }) {
  const [open, setOpen] = useState(false);
  const { detail } = record;
  const before = detail.before, after = detail.after;
  const changes = before && after && typeof before === "object" && typeof after === "object" ? Array.from(new Set([...Object.keys(before), ...Object.keys(after)])) : [];
  return <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger asChild><Button variant="link">查看详情</Button></Dialog.Trigger><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
    <Dialog.Content data-slot="dialog-content" className="admin-audit-dialog fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 gap-5 overflow-y-auto bg-popover p-6 text-popover-foreground outline-none">
      <div><Dialog.Title className="text-xl font-semibold">审计详情</Dialog.Title><Dialog.Description className="mt-2 text-sm text-muted-foreground">#{record.id} · {dateText(record.created_at)} · {actions[record.action] ?? record.action}</Dialog.Description></div>
      <dl className="grid gap-3 text-sm"><div><dt className="text-muted-foreground">操作者</dt><dd className="mt-1 break-all">{record.actorEmail ?? record.actor}</dd></div><div><dt className="text-muted-foreground">对象</dt><dd className="mt-1 break-all">{record.target}</dd></div></dl>
      {typeof detail.reason === "string" && <p>原因：{detail.reason || "历史记录未填写"}</p>}
      {changes.length ? <table><thead><tr><th>字段</th><th>变更前</th><th>变更后</th></tr></thead><tbody>{changes.map(key => <tr key={key}><td>{key}</td><td><pre>{JSON.stringify((before as Record<string, unknown>)[key], null, 2) ?? "未记录"}</pre></td><td><pre>{JSON.stringify((after as Record<string, unknown>)[key], null, 2) ?? "未记录"}</pre></td></tr>)}</tbody></table> : <pre>{JSON.stringify(detail, null, 2)}</pre>}
      <div className="flex flex-wrap justify-end gap-3"><Button variant="outline" onClick={() => { onFilterTarget(); setOpen(false); }}>查看此对象的记录</Button><Dialog.Close asChild><Button>关闭</Button></Dialog.Close></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
function auditTargetLabel(target: string) {
  const names: Record<string, string> = { settings: "系统设置", users: "用户", provider: "提供商用量", service: "服务状态", tasks: "任务", "/api/admin/import-settings": "识别设置", "/api/admin/settings": "系统设置", "/api/admin/users": "用户管理", "/api/admin/audit": "审计记录", "/api/admin/usage": "提供商用量", "/api/admin/calls": "调用记录", "/api/admin/operations": "运行状态", "/api/admin/task-search": "任务管理", "/api/admin/payments": "订单与退款" };
  const match = Object.keys(names).find(key => target === key || target.startsWith(key + "/"));
  return match ? names[match] : /^[a-f0-9-]{32,36}$/i.test(target) ? `对象 …${target.slice(-8)}` : target;
}
export function AdminAudit({ initial = {}, navigate }: { initial?: AdministrationFilter; navigate: AdminNavigate }) {
  const [filters, setFilters] = useState(initial), [offset, setOffset] = useState(0);
  const read = useAdminRead<AdministrationAudit[]>(`/api/admin/audit?${query(filters, offset)}`);
  return <><div className="section-heading"><h1>审计记录</h1><Button variant="outline" onClick={read.reload}>刷新审计</Button></div><FilterBar key={query(filters)} kind="audit" initial={filters} apply={value => { setFilters(value); setOffset(0); }} /><ReadState {...read} retry={read.reload} />
    {read.data && !read.data.length && <p className="account-empty-state">没有匹配的审计记录。</p>}
    {!!read.data?.length && <div className="account-table"><table><thead><tr><th>时间</th><th>操作记录</th><th>操作者</th><th>详情</th></tr></thead><tbody>{read.data.map(row => <tr key={row.id}><td>{dateText(row.created_at)}</td><td><span className="font-medium">{actions[row.action] ?? "其他操作"}</span><small title={row.target}>{auditTargetLabel(row.target)}</small></td><td>{row.actor === "operator" ? "系统管理员" : row.actor === "monitoring" ? "监控服务" : <Button variant="link" title={row.actor} onClick={() => navigate("users", {}, row.actor)}>{row.actorEmail ?? `账户 …${row.actor.slice(-8)}`}</Button>}</td><td><ChangeDetail record={row} onFilterTarget={() => { setFilters({ ...filters, target: row.target, userId: "" }); setOffset(0); }} /></td></tr>)}</tbody></table></div>}
    <Pagination offset={offset} size={100} more={read.data?.length === 100} change={setOffset} />
  </>;
}
export function AdminOperations({ navigate }: { navigate: AdminNavigate }) {
  const read = useAdminRead<AdministrationOperations>("/api/admin/operations");
  const value = read.data;
  const cost = (amount: number | null | undefined) => amount == null ? "未启用" : `${amount / 1_000_000} ${value?.costCurrency || "（未配置币种）"}`;
  return <div className="admin-operations"><div className="section-heading"><div><h1>运行状态与异常处理</h1>{value && <p>采集时间：{dateText(value.observedAt)}</p>}</div><Button variant="outline" onClick={read.reload}>刷新运行状态</Button></div><ReadState {...read} retry={read.reload} />
    {value && <>
      <section aria-labelledby="operations-actions"><h2 id="operations-actions">待处理记录</h2><div className="admin-links"><Button variant="outline" onClick={() => navigate("users", { issue: "quota" })}>识别额度已耗尽的用户</Button><Button variant="outline" onClick={() => navigate("tasks", { issue: "quota" })}>额度或预算阻塞</Button><Button variant="outline" onClick={() => navigate("tasks", { issue: "unknown" })}>未知任务调用</Button><Button variant="outline" onClick={() => navigate("usage", { state: "unknown" })}>未知调用回执</Button><Button variant="outline" onClick={() => navigate("tasks", { issue: "stalled" })}>超过 30 分钟的任务</Button><Button variant="outline" onClick={() => navigate("payments", { issue: "refund" })}>退款未确认或权益冻结</Button></div></section>
      <div className="admin-operations-sections">
      <section className="admin-operations-service" aria-labelledby="operations-service"><h2 id="operations-service">服务与队列</h2><Facts><Fact label="服务状态">{value.readOnly ? "只读" : value.maintenance ? "维护中" : value.accepting ? "接收任务" : "未就绪"}</Fact><Fact label="数据库版本">schema {value.schemaVersion}</Fact><Fact label="代码版本"><span className="admin-code-version" title={value.codeVersion}>{value.codeVersion}</span></Fact><Fact label="RabbitMQ 发布 / 消费连接">{value.broker.publisher ? "已连接" : "未连接"} / {value.broker.consumer ? "已连接" : "未连接"}</Fact><Fact label="等待 / 运行">{value.runs.pending ?? 0} / {value.runs.running ?? 0} 个任务</Fact><Fact label="待发布 / 最老待发布">{value.outboxPending} 个 / {Math.round(value.oldestPendingSeconds)} 秒</Fact><Fact label="任务容量 / 空闲执行位">{value.queueCapacity} / {value.workersAvailable}</Fact><Fact label="存储健康 / 可用空间">{value.storageHealthy == null ? "未取得状态" : value.storageHealthy ? "正常" : "异常"} / {value.storageFreeBytes == null ? "未知" : `${(value.storageFreeBytes / 1024 ** 3).toFixed(2)} GiB`}</Fact></Facts></section>
      <section className="admin-operations-budget" aria-labelledby="operations-budget"><h2 id="operations-budget">模型与预算</h2><Facts><Fact label="模型">{value.modelId || "未配置"}</Fact><Fact label="腾讯识别配置">{value.parserConfigured ? "已配置" : "未配置"}</Fact><Fact label="任务估算费用上限">{cost(value.taskCostLimitMicros)}</Fact><Fact label="UTC 日估算费用上限">{cost(value.dailyCostLimitMicros)}</Fact><Fact label="UTC 日保守预留费用">{cost(value.dailyReservedMicros)}</Fact></Facts></section>
      </div>
    </>}
  </div>;
}
