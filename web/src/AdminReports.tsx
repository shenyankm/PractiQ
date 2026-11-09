import { useState } from "react";
import type { AdministrationAudit, AdministrationCall, AdministrationFilter, AdministrationOperations, AdministrationUsageSummary } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Fact, Facts, FilterBar, Pagination, ReadState, callStates, dateText, query, useAdminRead, type AdminNavigate } from "./adminTools";

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
    {calls.data && !calls.data.length && <p>没有匹配的调用记录。</p>}
    {!!calls.data?.length && <div className="account-table"><table><thead><tr><th>调用 / 时间</th><th>用户</th><th>关联任务或评分</th><th>供应商 / 状态</th><th>回执</th></tr></thead><tbody>{calls.data.map(row => <tr key={row.call_key}><td>{row.call_key}<small>{dateText(row.created_at)}</small></td><td><Button variant="link" onClick={() => navigate("users", {}, row.user_id ?? "")}>{row.email}</Button></td><td><Scope scope={row.scope} navigate={navigate} /></td><td>{row.provider}<small>{callStates[row.state]} · {row.status}</small></td><td><details><summary>查看调用回执</summary><pre>{JSON.stringify(row.record, null, 2)}</pre></details></td></tr>)}</tbody></table></div>}
    <Pagination offset={offset} size={100} more={calls.data?.length === 100} change={setOffset} />
  </>;
}
const actions: Record<string, string> = { allowance_update: "调整免费额度", user_update: "修改用户权限或额度", user_session_revoke: "撤销用户会话", user_token_revoke: "撤销评分令牌", settings_update: "修改注册与默认额度", import_settings_update: "修改执行策略", reset_link_create: "签发密码重置码", password_reset: "完成密码重置", admin_request: "访问管理接口", payment_refund: "发起退款" };
function ChangeDetail({ detail }: { detail: Record<string, unknown> }) {
  const before = detail.before, after = detail.after;
  const changes = before && after && typeof before === "object" && typeof after === "object" ? Array.from(new Set([...Object.keys(before), ...Object.keys(after)])) : [];
  return <>{typeof detail.reason === "string" && <p>原因：{detail.reason || "历史记录未填写"}</p>}{changes.length ? <details><summary>查看变更前后</summary><table><thead><tr><th>字段</th><th>变更前</th><th>变更后</th></tr></thead><tbody>{changes.map(key => <tr key={key}><td>{key}</td><td><pre>{JSON.stringify((before as Record<string, unknown>)[key], null, 2) ?? "未记录"}</pre></td><td><pre>{JSON.stringify((after as Record<string, unknown>)[key], null, 2) ?? "未记录"}</pre></td></tr>)}</tbody></table></details> : <details><summary>查看审计详情</summary><pre>{JSON.stringify(detail, null, 2)}</pre></details>}</>;
}
export function AdminAudit({ initial = {}, navigate }: { initial?: AdministrationFilter; navigate: AdminNavigate }) {
  const [filters, setFilters] = useState(initial), [offset, setOffset] = useState(0);
  const read = useAdminRead<AdministrationAudit[]>(`/api/admin/audit?${query(filters, offset)}`);
  return <><div className="section-heading"><h1>审计记录</h1><Button variant="outline" onClick={read.reload}>刷新审计</Button></div><FilterBar key={query(filters)} kind="audit" initial={filters} apply={value => { setFilters(value); setOffset(0); }} /><ReadState {...read} retry={read.reload} />
    {read.data && !read.data.length && <p>没有匹配的审计记录。</p>}
    {!!read.data?.length && <div className="account-table"><table><thead><tr><th>时间 / 编号</th><th>操作者</th><th>操作</th><th>对象</th><th>变更或详情</th></tr></thead><tbody>{read.data.map(row => <tr key={row.id}><td>{dateText(row.created_at)}<small>#{row.id}</small></td><td>{row.actor === "operator" || row.actor === "monitoring" ? row.actor : <Button variant="link" onClick={() => navigate("users", {}, row.actor)}>{row.actor}</Button>}</td><td>{actions[row.action] ?? row.action}<small>{row.action}</small></td><td>{row.target}<Button variant="outline" onClick={() => { const value = { ...filters, target: row.target, userId: "" }; setFilters(value); setOffset(0); }}>同一对象记录</Button></td><td><ChangeDetail detail={row.detail} /></td></tr>)}</tbody></table></div>}
    <Pagination offset={offset} size={100} more={read.data?.length === 100} change={setOffset} />
  </>;
}
export function AdminOperations({ navigate }: { navigate: AdminNavigate }) {
  const read = useAdminRead<AdministrationOperations>("/api/admin/operations");
  const value = read.data, monitoring = value?.monitoring;
  const cost = (amount: number | null | undefined) => amount == null ? "未启用" : `${amount / 1_000_000} ${value?.costCurrency || "（未配置币种）"}`;
  const monitoringLabels = { not_configured: "未接入外部状态", unavailable: "外部状态不可读取或格式无效", stale: "外部状态已过期", current: "外部状态在 15 分钟内更新" };
  return <><div className="section-heading"><h1>运行状态与异常处理</h1><Button variant="outline" onClick={read.reload}>刷新运行状态</Button></div><ReadState {...read} retry={read.reload} />
    {value && <><p>采集时间：{dateText(value.observedAt)}。此页面只读，不会发起模型、付款、备份或恢复。</p>
      <h2>待处理记录</h2><div className="admin-links"><Button variant="outline" onClick={() => navigate("users", { issue: "quota" })}>识别额度已耗尽的用户</Button><Button variant="outline" onClick={() => navigate("tasks", { issue: "quota" })}>额度或预算阻塞</Button><Button variant="outline" onClick={() => navigate("tasks", { issue: "unknown" })}>未知任务调用</Button><Button variant="outline" onClick={() => navigate("usage", { state: "unknown" })}>未知调用回执</Button><Button variant="outline" onClick={() => navigate("tasks", { issue: "stalled" })}>超过 30 分钟的任务</Button><Button variant="outline" onClick={() => navigate("payments", { issue: "refund" })}>退款未确认或权益冻结</Button></div>
      <h2>服务与队列</h2><Facts><Fact label="服务状态">{value.readOnly ? "只读" : value.maintenance ? "维护中" : value.accepting ? "接收任务" : "未就绪"}</Fact><Fact label="数据库版本">schema {value.schemaVersion}</Fact><Fact label="代码版本">{value.codeVersion}</Fact><Fact label="RabbitMQ 发布 / 消费连接">{value.broker.publisher ? "已连接" : "未连接"} / {value.broker.consumer ? "已连接" : "未连接"}</Fact><Fact label="等待 / 运行">{value.runs.pending ?? 0} / {value.runs.running ?? 0} 个任务</Fact><Fact label="待发布 / 最老待发布">{value.outboxPending} 个 / {Math.round(value.oldestPendingSeconds)} 秒</Fact><Fact label="任务容量 / 空闲执行位">{value.queueCapacity} / {value.workersAvailable}</Fact><Fact label="存储健康 / 可用空间">{value.storageHealthy == null ? "未取得状态" : value.storageHealthy ? "正常" : "异常"} / {value.storageFreeBytes == null ? "未知" : `${(value.storageFreeBytes / 1024 ** 3).toFixed(2)} GiB`}</Fact></Facts>
      <h2>模型与预算</h2><Facts><Fact label="模型">{value.modelId || "未配置"}</Fact><Fact label="腾讯识别配置">{value.parserConfigured ? "已配置（连接仍需独立验证）" : "未配置"}</Fact><Fact label="任务估算费用上限">{cost(value.taskCostLimitMicros)}</Fact><Fact label="UTC 日估算费用上限">{cost(value.dailyCostLimitMicros)}</Fact><Fact label="UTC 日保守预留费用">{cost(value.dailyReservedMicros)}</Fact></Facts><p>估算预留包含不确定结果，不等于供应商账单；本页不显示或修改密钥。</p>
      <h2>备份与告警</h2><p role="status">{monitoringLabels[value.monitoringState]}</p>
      {monitoring ? <Facts><Fact label="外部状态观察时间">{dateText(monitoring.observedAt)}</Fact><Fact label="最近成功备份快照">{dateText(monitoring.backupLastSuccessAt)}{monitoring.backupLastSuccessAt && new Date(value.observedAt).getTime() - new Date(monitoring.backupLastSuccessAt).getTime() > 900_000 ? "（超过 15 分钟）" : ""}</Fact><Fact label="最近备份尝试">{monitoring.backupLastAttemptSuccess == null ? "未知" : monitoring.backupLastAttemptSuccess ? "成功" : "失败"}</Fact><Fact label="外部告警快照">{monitoring.alertState === "firing" ? "存在活动告警" : monitoring.alertState === "healthy" ? "未发现活动告警" : "未知"}{value.monitoringState === "stale" && "（状态已过期）"}</Fact><Fact label="最近真实告警投递验证">{dateText(monitoring.alertDeliveryVerifiedAt)}</Fact></Facts> : <p>需由运维接入可信的备份及监控状态文件。缺少证据时不视为健康；实际告警送达和异机恢复仍需演练。</p>}
    </>}
  </>;
}
