import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Chip, Description, FieldError, Form, Input, Label, TextArea, TextField, Typography } from '@heroui/react';
import { fileDigest, get, mutate, type ImportJob, type Question, type Task } from './api';
import { Confirm, Empty, Go, LoadState, Notice, PageTitle, Panel, Pager, useAction, useResource } from './ui';

interface PendingImport { id?: number; digest: string; name: string; bankId?: number; bankName?: string; description?: string; tags?: string[]; sourceType: string; createKey: string; uploadKey: string; parseKey: string }
function restore(): PendingImport | null { try { const p = JSON.parse(localStorage.getItem('practiq-import') ?? 'null') as PendingImport | null; return p && typeof p.digest === 'string' && typeof p.createKey === 'string' && (typeof p.bankId === 'number' || typeof p.bankName === 'string') ? p : null; } catch { return null; } }
const labels: Record<string, string> = { queued: '等待上传或提交', processing: '处理中', completed: '已完成', failed: '失败', cancelled: '已取消', running: '运行中', succeeded: '成功', timed_out: '超时' };
export function Imports() {
  const [cursor, setCursor] = useState(''), state = useResource<ImportJob[]>(`/import-jobs?cursor=${cursor}`, true);
  return <><PageTitle title="题目导入" /><div className="grid gap-6 lg:grid-cols-2"><section className="flex min-w-0 flex-col gap-4"><ImportCreate embedded /></section><section className="flex min-w-0 flex-col gap-4"><Typography.Heading level={2}>导入记录</Typography.Heading><LoadState state={state} />{state.data?.length === 0 && <Empty>支持文本、CSV、PDF、Word、Excel 与图片。</Empty>}{state.data?.map(j => <Panel key={j.id} title={j.file_name}><div className="flex flex-wrap items-center gap-4"><Chip>{labels[j.status]}</Chip><Go to={`/imports/${j.id}`}>查看进度和结果</Go></div></Panel>)}<Pager cursor={cursor} hasMore={state.pagination?.hasMore} onFirst={() => setCursor('')} onNext={() => setCursor(state.pagination!.cursor)} /></section></div></>;
}
interface MetadataRequest { id?: number; name: string; key: string }
function restoreMetadata(): MetadataRequest | null {
  try { const value = JSON.parse(localStorage.getItem('practiq-import-metadata') ?? 'null') as MetadataRequest | null;
    return value && typeof value.name === 'string' && typeof value.key === 'string' ? value : null;
  } catch { return null; }
}
const sourceTypes: Record<string, string> = { txt: 'text', md: 'text', csv: 'csv', pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image' };
export function ImportCreate({ embedded = false }: { embedded?: boolean }) {
  const [pending, setPending] = useState(restore), [metadata, setMetadata] = useState(restoreMetadata);
  const [name, setName] = useState(pending?.bankName ?? metadata?.name ?? '');
  const [description, setDescription] = useState(pending?.description ?? ''), [tags, setTags] = useState(pending?.tags?.join('，') ?? '');
  const [picked, setPicked] = useState<File | null>(null);
  const file = useRef<HTMLInputElement>(null), action = useAction(), ai = useAction(), navigate = useNavigate();
  const task = useResource<Task>(metadata?.id ? `/ai-tasks/${metadata.id}` : null, true);
  const generating = ai.busy || (!!metadata?.id && (!task.data || ['queued', 'running'].includes(task.data.status)));
  const locked = action.busy || !!pending;
  const save = (p: PendingImport) => { localStorage.setItem('practiq-import', JSON.stringify(p)); setPending(p); };
  async function generate() {
    const request = metadata?.name === name.trim() && !metadata.id ? metadata : { name: name.trim(), key: crypto.randomUUID() };
    if (!request.name) throw new Error('请先输入名称');
    localStorage.setItem('practiq-import-metadata', JSON.stringify(request)); setMetadata(request);
    const created = await mutate<Task>('/bank-metadata-tasks', 'POST', { name: request.name }, request.key);
    const saved = { ...request, id: created.id };
    localStorage.setItem('practiq-import-metadata', JSON.stringify(saved)); setMetadata(saved);
  }
  async function upload() {
    if (!picked || (!name.trim() && !pending?.bankId)) throw new Error('请输入名称并选择文件');
    if (picked.size === 0 || picked.size > 25*1024*1024) throw new Error('文件大小应为 1 字节至 25 MiB');
    const sourceType = sourceTypes[picked.name.split('.').pop()?.toLowerCase() ?? ''];
    if (!sourceType) throw new Error('不支持此文件格式，请选择 TXT、Markdown、CSV、PDF、DOCX、XLSX 或图片');
    const parsedTags = [...new Set(tags.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean))];
    if (parsedTags.length > 30 || parsedTags.some(tag => tag.length > 64)) throw new Error('最多 30 个标签，每个不超过 64 个字符');
    const digest = await fileDigest(picked);
    if (pending && (pending.digest !== digest || pending.sourceType !== sourceType)) throw new Error('恢复时请选择原文件；若要导入其他文件，请先放弃本地恢复。');
    const p = pending ?? { digest, name: picked.name, bankName: name.trim(), description: description.trim(), tags: parsedTags, sourceType, createKey: crypto.randomUUID(), uploadKey: crypto.randomUUID(), parseKey: crypto.randomUUID() };
    save(p);
    if (!p.id) {
      const target = p.bankId ? { bankId: p.bankId } : { name: p.bankName, description: p.description ?? '', tags: p.tags ?? [] };
      const job = await mutate<ImportJob>('/import-jobs', 'POST', { ...target, sourceType: p.sourceType, fileName: p.name }, p.createKey);
      p.id = job.id; save({ ...p });
    }
    const current = (await get<ImportJob>(`/import-jobs/${p.id}`)).data;
    if (current.status === 'queued' && current.ai_task_id === null) {
      const form = new FormData(); form.append('file', picked, p.name);
      await mutate(`/import-jobs/${p.id}/file`, 'POST', form, p.uploadKey);
      await mutate(`/import-jobs/${p.id}/parse`, 'POST', undefined, p.parseKey);
    }
    localStorage.removeItem('practiq-import'); localStorage.removeItem('practiq-import-metadata');
    setPending(null); navigate(`/imports/${p.id}`);
  }
  return <>
    {!embedded && <PageTitle title="新建导入"><Go to="/imports">导入记录</Go></PageTitle>}
    <div className="mx-auto w-full max-w-2xl min-w-0"><Panel title="导入并新建题库" description="上传资料后由 AI 提取题目，结果保存为草稿，核对后再发布。">
      <Form className="flex flex-col gap-5" onSubmit={e => { e.preventDefault(); void action.run(upload); }}>
        <TextField name="name" value={name} onChange={setName} isRequired={!pending?.bankId} isDisabled={locked} maxLength={100} fullWidth>
          <Label>名称</Label><Input placeholder="例如：高等数学期末复习" /><FieldError />
        </TextField>
        <TextField name="description" value={description} onChange={setDescription} isDisabled={locked} maxLength={500} fullWidth>
          <Label>描述（非必填）</Label><TextArea rows={3} placeholder="介绍题库内容和学习目标" /><FieldError />
        </TextField>
        <TextField name="tags" value={tags} onChange={setTags} isDisabled={locked} fullWidth>
          <Label>标签（非必填）</Label><Input placeholder="数学，期末复习" /><Description>使用逗号分隔，最多 30 个标签。</Description><FieldError />
        </TextField>
        <div className="flex flex-col items-start gap-3">
          <Button type="button" variant="secondary" isDisabled={!name.trim() || locked || generating} onPress={() => void ai.run(generate)}>{generating ? 'AI 生成中…' : 'AI 生成描述和标签'}</Button>
          <Description>根据名称生成建议，不会读取文件或自动覆盖已填写内容。</Description>
          {ai.error && <Notice>{ai.error}</Notice>}
          {metadata?.id && <><LoadState state={task} />
            {task.data?.error && <Notice>{task.data.error.message}</Notice>}
            {task.data?.status === 'succeeded' && task.data.result && <Panel title="AI 建议">
              <Typography.Paragraph>{task.data.result.description}</Typography.Paragraph>
              <div className="flex flex-wrap gap-2">{task.data.result.tags?.map(tag => <Chip key={tag}>{tag}</Chip>)}</div>
              <Button type="button" variant="secondary" isDisabled={locked || metadata.name !== name.trim()} onPress={() => { setDescription(task.data!.result!.description ?? ''); setTags(task.data!.result!.tags?.join('，') ?? ''); }}>采用 AI 建议</Button>
              {metadata.name !== name.trim() && <Description>名称已修改，请重新生成后采用。</Description>}
            </Panel>}
            {task.data && ['queued', 'running'].includes(task.data.status) && <Button type="button" variant="tertiary" onPress={() => void ai.run(async () => { await mutate(`/ai-tasks/${metadata.id}/cancel`); task.reload(); })}>取消生成</Button>}
          </>}
        </div>
        <div className="flex flex-col items-start gap-3">
          <Label htmlFor="import-file">文件（必填）</Label>
          <input id="import-file" ref={file} type="file" hidden accept=".txt,.md,.csv,.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.gif,.webp" disabled={action.busy} onChange={e => setPicked(e.target.files?.[0] ?? null)} />
          <Button type="button" variant="secondary" isDisabled={action.busy} onPress={() => file.current?.click()}>选择文件</Button>
          <Typography.Paragraph className="max-w-full overflow-x-auto">{picked ? `${picked.name} · ${(picked.size/1024).toFixed(1)} KiB` : '尚未选择文件'}</Typography.Paragraph>
          <Description>支持 TXT、Markdown、CSV、PDF、Word DOCX、Excel XLSX、PNG、JPG、GIF、WebP；最大 25 MiB。文本和 CSV 使用 UTF-8 编码。</Description>
        </div>
        {pending && <Panel title="发现未完成的导入"><Typography.Paragraph>请重新选择 {pending.name}，继续恢复不会重复创建题库。</Typography.Paragraph>{pending.id && <Go to={`/imports/${pending.id}`}>先核对服务端进度</Go>}<Confirm label="放弃本地恢复" onConfirm={async () => { localStorage.removeItem('practiq-import'); setPending(null); }} /></Panel>}
        {action.error && <Notice>{action.error}</Notice>}
        <Button type="submit" isDisabled={action.busy || !picked || (!name.trim() && !pending?.bankId)}>{action.busy ? '上传并提交中…' : pending ? '恢复导入' : '上传并开始解析'}</Button>
      </Form>
    </Panel></div>
  </>;
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
