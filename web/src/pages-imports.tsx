import { useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Chip, Typography } from '@heroui/react';
import { fileDigest, get, mutate, type Bank, type ImportJob, type Question, type Task } from './api';
import { Choice, Confirm, Empty, Go, LoadState, Notice, PageTitle, Panel, useAction, useResource } from './ui';

interface PendingImport { id?: number; digest: string; name: string; bankId: number; sourceType: string; createKey: string; uploadKey: string; parseKey: string }
function restore(): PendingImport | null { try { const p = JSON.parse(localStorage.getItem('practiq-import') ?? 'null') as PendingImport | null; return p && typeof p.digest === 'string' && typeof p.createKey === 'string' && typeof p.bankId === 'number' ? p : null; } catch { return null; } }
const labels: Record<string, string> = { queued: '等待上传或提交', processing: '处理中', completed: '已完成', failed: '失败', cancelled: '已取消', running: '运行中', succeeded: '成功', timed_out: '超时' };
export function Imports() {
  const [cursor, setCursor] = useState(''), state = useResource<ImportJob[]>(`/import-jobs?cursor=${cursor}`, true);
  return <><PageTitle title="导入资料"><Go to="/imports/new">新建导入</Go></PageTitle><Typography.Paragraph className="max-w-full overflow-x-auto">上传文件后由 AI 提取题目。导入结果保存为草稿，核对后再发布。</Typography.Paragraph><LoadState state={state} />{state.data?.length === 0 && <Empty>支持文本、CSV、PDF、Word、Excel 与图片。</Empty>}{state.data?.map(j => <Panel key={j.id} title={j.file_name}><div className="flex flex-wrap items-center gap-4"><Chip>{labels[j.status]}</Chip><Go to={`/imports/${j.id}`}>查看进度和结果</Go></div></Panel>)}<div className="flex gap-3">{cursor && <Button variant="secondary" onPress={() => setCursor('')}>第一页</Button>}{state.pagination?.hasMore && <Button variant="secondary" onPress={() => setCursor(state.pagination!.cursor)}>下一页</Button>}</div></>;
}
export function ImportCreate() {
  const [params] = useSearchParams(), [pending, setPending] = useState(restore), [bankId, setBankId] = useState(params.get('bankId') ?? pending?.bankId.toString() ?? '');
  const [picked, setPicked] = useState<File | null>(null), [sourceType, setSourceType] = useState(pending?.sourceType ?? 'text');
  const banks = useResource<Bank[]>('/banks?limit=100'), file = useRef<HTMLInputElement>(null), action = useAction(), navigate = useNavigate();
  const save = (p: PendingImport) => { localStorage.setItem('practiq-import', JSON.stringify(p)); setPending(p); };
  async function upload() {
    if (!picked || !bankId) throw new Error('请选择题库与文件');
    if (picked.size === 0 || picked.size > 25*1024*1024) throw new Error('文件大小应为 1 字节至 25 MiB');
    const digest = await fileDigest(picked);
    if (pending && (pending.digest !== digest || pending.bankId !== Number(bankId) || pending.sourceType !== sourceType)) throw new Error('恢复时请选择原文件与原题库；若要导入其他文件，请先放弃本地恢复。');
    const p = pending ?? { digest, name: picked.name, bankId: Number(bankId), sourceType, createKey: crypto.randomUUID(), uploadKey: crypto.randomUUID(), parseKey: crypto.randomUUID() };
    save(p);
    if (!p.id) { const job = await mutate<ImportJob>('/import-jobs', 'POST', { bankId: p.bankId, sourceType: p.sourceType, fileName: p.name }, p.createKey); p.id = job.id; save({ ...p }); }
    const current = (await get<ImportJob>(`/import-jobs/${p.id}`)).data;
    if (current.status === 'queued' && current.ai_task_id === null) {
      const form = new FormData(); form.append('file', picked, p.name);
      await mutate(`/import-jobs/${p.id}/file`, 'POST', form, p.uploadKey);
      await mutate(`/import-jobs/${p.id}/parse`, 'POST', undefined, p.parseKey);
    }
    localStorage.removeItem('practiq-import'); setPending(null); navigate(`/imports/${p.id}`);
  }
  return <><PageTitle title="新建导入"><Go to="/imports">导入记录</Go></PageTitle><div className="mx-auto w-full max-w-2xl"><Panel title="选择资料" description="最大 25 MiB。文本和 CSV 使用 UTF-8 编码。"><LoadState state={banks} /><Choice label="目标题库" value={bankId} onChange={setBankId} items={(banks.data ?? []).map(b => ({ id: String(b.id), label: b.name }))} /><Choice label="文件类型" value={sourceType} onChange={setSourceType} items={[{ id: 'text', label: '文本 / Markdown' }, { id: 'csv', label: 'CSV' }, { id: 'pdf', label: 'PDF' }, { id: 'docx', label: 'Word DOCX' }, { id: 'xlsx', label: 'Excel XLSX' }, { id: 'image', label: '图片' }]} /><input ref={file} type="file" hidden accept=".txt,.md,.csv,.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.gif,.webp" onChange={e => setPicked(e.target.files?.[0] ?? null)} /><Button variant="secondary" onPress={() => file.current?.click()}>选择文件</Button><Typography.Paragraph className="max-w-full overflow-x-auto">{picked ? `${picked.name} · ${(picked.size/1024).toFixed(1)} KiB` : '尚未选择文件'}</Typography.Paragraph>{pending && <Panel title="发现未完成的导入"><Typography.Paragraph className="max-w-full overflow-x-auto">请重新选择 {pending.name}，可使用相同请求继续恢复。</Typography.Paragraph>{pending.id && <Go to={`/imports/${pending.id}`}>先核对服务端进度</Go>}<Confirm label="放弃本地恢复" onConfirm={async () => { localStorage.removeItem('practiq-import'); setPending(null); }} /></Panel>}{action.error && <Notice>{action.error}</Notice>}<Button isDisabled={action.busy || !picked || !bankId} onPress={() => void action.run(upload)}>{action.busy ? '上传并提交中…' : pending ? '恢复导入' : '上传并开始解析'}</Button></Panel></div></>;
}
export function ImportDetail() {
  const id = Number(useParams().id), state = useResource<ImportJob>(`/import-jobs/${id}`, true), [cursor, setCursor] = useState('');
  const outputs = useResource<{ question_id: number; stem: string }[]>(`/import-jobs/${id}/outputs?cursor=${cursor}`, true), events = useResource<{ id: number; stage: string; status: string; created_at: string }[]>(`/import-jobs/${id}/events`, true);
  const action = useAction(), job = state.data;
  return <><PageTitle title={job?.file_name ?? '导入详情'}><Go to="/imports">全部导入</Go></PageTitle><LoadState state={state} />{job && <Panel title="处理状态"><Chip>{labels[job.status]}</Chip>{job.task?.error && <Notice>{job.task.error.message}</Notice>}<div className="flex flex-wrap gap-3">{job.status === 'failed' && !job.source_deleted_at && <Button isDisabled={action.busy} onPress={() => void action.run(async () => { await mutate(`/import-jobs/${id}/retry`); state.reload(); })}>重试解析</Button>}{['queued', 'processing'].includes(job.status) && <Confirm label="取消导入" onConfirm={async () => { await mutate(`/import-jobs/${id}/cancel`); state.reload(); }} />}<Go to={`/banks/${job.bank_id}`}>打开题库</Go></div>{action.error && <Notice>{action.error}</Notice>}</Panel>}<div className="grid gap-6 lg:grid-cols-2"><Panel title="导入结果"><LoadState state={outputs} />{outputs.data?.length === 0 && <Empty>结果尚未生成。</Empty>}{outputs.data?.map(q => <div key={q.question_id} className="flex flex-col gap-2"><Typography.Paragraph className="max-w-full overflow-x-auto">{q.stem}</Typography.Paragraph><Go to={`/questions/${q.question_id}`}>核对并发布</Go></div>)}<div className="flex gap-3">{cursor && <Button variant="secondary" onPress={() => setCursor('')}>第一页</Button>}{outputs.pagination?.hasMore && <Button variant="secondary" onPress={() => setCursor(outputs.pagination!.cursor)}>下一页</Button>}</div></Panel><Panel title="处理记录">{events.data?.map(e => <Typography.Paragraph key={e.id}>{new Date(e.created_at).toLocaleString()} · {e.stage} · {labels[e.status] ?? e.status}</Typography.Paragraph>)}</Panel></div></>;
}
export function TaskPage() {
  const id = Number(useParams().id), state = useResource<Task>(`/ai-tasks/${id}`, true), action = useAction(), navigate = useNavigate();
  const task = state.data;
  return <><PageTitle title={`AI 任务 #${id}`}><Go to="/analytics">返回分析</Go></PageTitle><LoadState state={state} />{task && <Panel title={task.kind === 'learning_report' ? '学习报告' : task.kind === 'answer_generation' ? '生成答案' : '文档解析'}><Chip>{labels[task.status]}</Chip>{task.error && <Notice>{task.error.message}</Notice>}{task.result && <><Typography.Paragraph className="max-w-full overflow-x-auto">{task.result.summary ?? task.result.canonicalAnswer}</Typography.Paragraph><Typography.Paragraph className="max-w-full overflow-x-auto">{task.result.explanation}</Typography.Paragraph>{task.result.steps?.map((s, i) => <Typography.Paragraph key={i}>{i+1}. {s}</Typography.Paragraph>)}{task.result.recommendations?.map((s, i) => <Typography.Paragraph key={i}>{s}</Typography.Paragraph>)}</>}{task.kind === 'answer_generation' && task.result?.answerPayload && task.source_question_id && <Button isDisabled={action.busy} onPress={() => void action.run(async () => { const qid = task.source_question_id!; const q = (await get<Question>(`/questions/${qid}/management`)).data; await mutate(`/questions/${qid}/answer-keys`, 'POST', { answerMode: q.answer_mode, answerPayload: task.result!.answerPayload, explanationPayload: { explanation: task.result!.explanation } }); navigate(`/questions/${qid}`); })}>采用为新答案版本</Button>}{['queued', 'running'].includes(task.status) && <Confirm label="取消任务" onConfirm={async () => { await mutate(`/ai-tasks/${id}/cancel`); state.reload(); }} />}{action.error && <Notice>{action.error}</Notice>}<Typography.Paragraph className="max-w-full overflow-x-auto">已记录模型调用：{task.usage?.length ?? 0} 次</Typography.Paragraph></Panel>}</>;
}
