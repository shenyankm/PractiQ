import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Label, Link, Typography } from '@heroui/react';
import { apiRequest } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import type { Bank, ImportJob } from '@/lib/types';

export default function ImportsPage() {
  const jobs = useApiResource<ImportJob[]>('/api/v1/import-jobs', []);
  const banks = useApiResource<Bank[]>('/api/v1/banks?scope=mine&limit=100', []);
  const [bankId, setBankId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || !bankId) return;
    setPending(true);
    setError('');
    try {
      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      const job = await apiRequest<ImportJob>('/api/v1/import-jobs', {
        method: 'POST',
        json: { bankId: Number(bankId), fileName: file.name, sourceType: extension, requestPayload: {} }
      });
      const form = new FormData();
      form.append('file', file);
      await apiRequest(`/api/v1/import-jobs/${job.id}/file`, { method: 'POST', body: form });
      await apiRequest(`/api/v1/import-jobs/${job.id}/parse`, { method: 'POST', json: { persistQuestions: true } });
      window.location.assign(`/imports/${job.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '上传失败');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="grid gap-5">
      <Typography.Heading level={1}>文档导入</Typography.Heading>
      <Card>
        <Card.Header><Typography.Heading level={2}>上传文件</Typography.Heading></Card.Header>
        <Card.Content>
          <form className="grid gap-3" onSubmit={upload}>
            {error ? <Alert status="danger"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert> : null}
            <Label htmlFor="import-bank">目标题库</Label>
            <select id="import-bank" required className="rounded-xl border p-3" value={bankId} onChange={(event) => setBankId(event.target.value)}>
              <option value="">请选择</option>
              {banks.data.map((bank) => <option key={bank.id} value={bank.id}>{bank.name}</option>)}
            </select>
            <Label htmlFor="import-file">TXT、DOCX、PDF 或 XLSX</Label>
            <input id="import-file" required type="file" accept=".txt,.docx,.pdf,.xlsx" onChange={(event) => setFile(event.target.files?.[0] || null)} />
            <Button type="submit" variant="primary" isDisabled={pending || !file || !bankId}>{pending ? '上传中…' : '上传并解析'}</Button>
          </form>
        </Card.Content>
      </Card>
      <div className="grid gap-3">
        {jobs.data.map((job) => (
          <Card key={job.id}>
            <Card.Content className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p>{job.file_name || `导入任务 #${job.id}`}</p>
                <p className="text-sm text-muted">{job.status} · {job.imported_questions}/{job.total_questions}</p>
              </div>
              <Link href={`/imports/${job.id}`}>查看详情</Link>
            </Card.Content>
          </Card>
        ))}
        {!jobs.loading && !jobs.data.length ? <p>还没有导入任务。</p> : null}
      </div>
    </section>
  );
}
