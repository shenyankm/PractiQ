import { useEffect } from 'react';
import { Alert, Button, Card, Link, Typography } from '@heroui/react';
import { useParams } from 'react-router-dom';
import { PageState } from '@/components/PageState';
import { apiRequest } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import type { ImportJob } from '@/lib/types';

type ImportEvent = { id: number; message?: string; status: string; created_at: string };
type ImportOutput = { id: number; question_id: number; confidence?: number };

export default function ImportDetailPage() {
  const { jobId = '' } = useParams();
  const job = useApiResource<ImportJob>(`/api/v1/import-jobs/${jobId}`, {} as ImportJob);
  const events = useApiResource<ImportEvent[]>(`/api/v1/import-jobs/${jobId}/events`, []);
  const outputs = useApiResource<ImportOutput[]>(`/api/v1/import-jobs/${jobId}/outputs`, []);
  const reloadJob = job.reload;
  const reloadEvents = events.reload;
  const reloadOutputs = outputs.reload;

  useEffect(() => {
    if (!job.data.status || ['completed', 'failed', 'cancelled'].includes(job.data.status)) return;
    const timer = window.setInterval(() => {
      void reloadJob();
      void reloadEvents();
      void reloadOutputs();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [job.data.status, reloadEvents, reloadJob, reloadOutputs]);

  async function run(action: 'retry' | 'cancel') {
    await apiRequest(`/api/v1/import-jobs/${jobId}/${action}`, { method: 'POST' });
    await job.reload();
  }

  return (
    <section className="grid gap-5">
      <Link href="/imports">返回导入列表</Link>
      <Typography.Heading level={1}>{job.data.file_name || `导入任务 #${jobId}`}</Typography.Heading>
      <PageState loading={job.loading} error={job.error} retry={() => void job.reload()} />
      {job.data.last_error ? <Alert status="danger"><Alert.Content><Alert.Description>{job.data.last_error}</Alert.Description></Alert.Content></Alert> : null}
      {!job.loading ? (
        <>
          <Card>
            <Card.Content className="grid gap-2">
              <p>状态：{job.data.status}</p>
              <p>阶段：{job.data.stage}</p>
              <p>进度：{Math.round(job.data.overall_progress_percent || 0)}%</p>
              <p>已导入：{job.data.imported_questions}/{job.data.total_questions}</p>
              <div className="flex gap-2">
                {job.data.status === 'failed' ? <Button onPress={() => void run('retry')}>重试</Button> : null}
                {['queued', 'processing'].includes(job.data.status) ? <Button onPress={() => void run('cancel')}>取消</Button> : null}
              </div>
            </Card.Content>
          </Card>
          <Card>
            <Card.Header><Typography.Heading level={2}>事件</Typography.Heading></Card.Header>
            <Card.Content className="grid gap-2">
              {events.data.map((event) => <p key={event.id}>{event.status} · {event.message || '状态更新'}</p>)}
            </Card.Content>
          </Card>
          <Card>
            <Card.Header><Typography.Heading level={2}>生成题目</Typography.Heading></Card.Header>
            <Card.Content className="grid gap-2">
              {outputs.data.map((output) => <Link key={output.id} href={`/questions/${output.question_id}`}>题目 #{output.question_id}</Link>)}
            </Card.Content>
          </Card>
        </>
      ) : null}
    </section>
  );
}
