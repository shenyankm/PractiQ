import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Alert, AlertDialog, Button, Card, FieldError, Form, Input, Label, Link, ListBox, Select, Spinner, TextArea, TextField, Typography } from '@heroui/react';
import { Link as RouterLink } from 'react-router-dom';
import { get, type Envelope } from './api';

export function Field({ label, value, onChange, multiline = false, required = false, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean; required?: boolean; type?: 'text' | 'number' }) {
  return <TextField value={value} onChange={onChange} isRequired={required} type={type} fullWidth><Label>{label}</Label>{multiline ? <TextArea rows={4} /> : <Input />}<FieldError /></TextField>;
}
export function Choice({ label, value, onChange, items }: { label: string; value: string; onChange: (v: string) => void; items: { id: string; label: string }[] }) {
  return <Select aria-label={label} value={value || null} onChange={v => onChange(String(v ?? ''))} fullWidth><Label>{label}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox>{items.map(i => <ListBox.Item id={i.id} key={i.id} textValue={i.label}>{i.label}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover></Select>;
}
export function Go({ to, children }: { to: string; children: ReactNode }) { return <Link href={to} render={props => <RouterLink {...props as Omit<ComponentProps<typeof RouterLink>, "to">} to={to} />}>{children}</Link>; }
export function Panel({ title, description, children }: { title: string; description?: string; children: ReactNode }) { return <Card className="min-w-0"><Card.Header><Card.Title className="max-w-full overflow-x-auto">{title}</Card.Title>{description && <Card.Description>{description}</Card.Description>}</Card.Header><Card.Content className="flex min-w-0 flex-col gap-4">{children}</Card.Content></Card>; }
export function PageTitle({ title, children }: { title: string; children?: ReactNode }) { return <header className="flex flex-wrap items-center justify-between gap-4"><Typography.Heading level={1} className="max-w-full overflow-x-auto">{title}</Typography.Heading>{children}</header>; }
export function Stat({ label, value }: { label: string; value: string | number }) { return <Panel title={label}><Typography.Heading level={2}>{value}</Typography.Heading></Panel>; }
export function Notice({ children }: { children: ReactNode }) { return <Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Title>操作未完成</Alert.Title><Alert.Description>{children}</Alert.Description></Alert.Content></Alert>; }
export function Empty({ children = '暂无内容，创建第一条记录开始吧。' }: { children?: ReactNode }) { return <Card><Card.Content className="flex min-w-0 flex-col items-center justify-center gap-2 py-10"><Typography.Paragraph className="max-w-full overflow-x-auto">{children}</Typography.Paragraph></Card.Content></Card>; }
export function Pager({ cursor, hasMore, onFirst, onNext }: { cursor: string; hasMore?: boolean; onFirst: () => void; onNext: () => void }) {
  if (!cursor && !hasMore) return null;
  return <div className="flex flex-wrap items-center gap-3">{cursor && <Button variant="secondary" onPress={onFirst}>第一页</Button>}{hasMore && <Button variant="secondary" onPress={onNext}>下一页</Button>}</div>;
}

export function useResource<T>(path: string | null, poll = false) {
  const [response, setResponse] = useState<Envelope<T> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(x => x+1), []);
  useEffect(() => {
    if (path === null) { setLoading(false); setResponse(null); return; }
    const endpoint = path;
    let disposed = false;
    let generation = 0;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      if (document.hidden) return;
      const current = ++generation;
      controller?.abort(); controller = new AbortController();
      try {
        const result = await get<T>(endpoint, controller.signal);
        if (!disposed && current === generation) { setResponse(result); setError(''); }
      } catch (e) {
        if (!disposed && current === generation && !(e instanceof DOMException && e.name === 'AbortError')) setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        if (!disposed && current === generation) { setLoading(false); if (poll && !document.hidden) timer = setTimeout(load, 2000); }
      }
    }
    setLoading(true); setResponse(null); setError(''); void load();
    const visible = () => { clearTimeout(timer); if (document.hidden) controller?.abort(); else void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; controller?.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [path, revision, poll]);
  return { data: response?.data, pagination: response?.meta?.pagination, error, loading, reload };
}
export function LoadState({ state }: { state: { error: string; loading: boolean; reload: () => void } }) {
  return state.loading ? <Spinner aria-label="加载中" /> : state.error ? <div className="flex flex-col gap-3"><Notice>{state.error}</Notice><Button variant="secondary" onPress={state.reload}>重试</Button></div> : null;
}
export function useAction() {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const lock = useRef(false);
  const run = async (work: () => Promise<unknown>) => { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { lock.current = false; setBusy(false); } };
  return { busy, error, run };
}
export function SaveForm({ action, onSave, children, label = '保存' }: { action: ReturnType<typeof useAction>; onSave: () => Promise<unknown>; children: ReactNode; label?: string }) { return <Form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void action.run(onSave); }}>{children}{action.error && <Notice>{action.error}</Notice>}<Button type="submit" className="self-start" isDisabled={action.busy}>{action.busy ? '处理中…' : label}</Button></Form>; }
export function Confirm({ label, onConfirm }: { label: string; onConfirm: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false); const action = useAction();
  return <><Button variant="danger-soft" onPress={() => setOpen(true)}>{label}</Button><AlertDialog isOpen={open} onOpenChange={setOpen}><AlertDialog.Backdrop><AlertDialog.Container><AlertDialog.Dialog><AlertDialog.Header><AlertDialog.Heading>{label}？</AlertDialog.Heading></AlertDialog.Header><AlertDialog.Body><Typography.Paragraph className="max-w-full overflow-x-auto">此操作会修改当前数据，请确认后继续。</Typography.Paragraph>{action.error && <Notice>{action.error}</Notice>}</AlertDialog.Body><AlertDialog.Footer><Button variant="secondary" isDisabled={action.busy} onPress={() => setOpen(false)}>取消</Button><Button variant="danger" isDisabled={action.busy} onPress={() => void action.run(async () => { await onConfirm(); setOpen(false); })}>确认</Button></AlertDialog.Footer></AlertDialog.Dialog></AlertDialog.Container></AlertDialog.Backdrop></AlertDialog></>;
}
