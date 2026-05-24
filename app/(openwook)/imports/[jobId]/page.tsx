import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Play, RotateCcw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getImportJob, listImportJobChildren } from '@/lib/openwook/services';
import { resolveReviewItemAction, updateImportStatusAction } from '../../banks/actions';
import { ImportLivePanel } from './import-live-panel';

type ReviewItemRow = {
  id: number;
  severity: string;
  code: string;
  payload_json: string;
  status: 'open' | 'resolved';
};

type OutputRow = {
  id: number;
  output_kind: 'question' | 'group';
  question_id: number | null;
  group_id: number | null;
};

type BlockRow = {
  id: number;
  block_id: string;
  status: string;
  page_start: number | null;
  page_end: number | null;
};

type EventRow = {
  id: number;
  step_label: string | null;
  step_code: string;
  status: string;
  message: string | null;
};

export default async function ImportDetailPage({ params }: { params: Promise<{ jobId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const { jobId } = await params;
  const id = Number(jobId);
  if (!Number.isInteger(id)) notFound();

  const [job, events, pages, blocks, reviewItems, outputs] = await Promise.all([
    getImportJob(user, id),
    listImportJobChildren(user, id, 'events'),
    listImportJobChildren(user, id, 'pages'),
    listImportJobChildren(user, id, 'blocks'),
    listImportJobChildren(user, id, 'review-items'),
    listImportJobChildren(user, id, 'outputs')
  ]);
  const eventRows = events as unknown as EventRow[];
  const blockRows = blocks as unknown as BlockRow[];
  const reviewRows = reviewItems as unknown as ReviewItemRow[];
  const outputRows = outputs as unknown as OutputRow[];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{job.file_name || `导入任务 #${job.id}`}</h1>
          <p className="mt-1 text-sm text-slate-500">{job.status} · {job.stage} · 风险 {job.risk_level}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <form action={updateImportStatusAction.bind(null, id, 'start')}>
            <Button size="sm" disabled={job.status === 'processing' || job.status === 'completed'}><Play className="size-4" />开始</Button>
          </form>
          <form action={updateImportStatusAction.bind(null, id, 'retry')}>
            <Button size="sm" variant="outline" disabled={job.status === 'processing'}><RotateCcw className="size-4" />重试</Button>
          </form>
          <form action={updateImportStatusAction.bind(null, id, 'cancel')}>
            <Button size="sm" variant="outline" disabled={job.status === 'completed' || job.status === 'failed'}><XCircle className="size-4" />取消</Button>
          </form>
        </div>
      </div>

      <ImportLivePanel
        job={job}
        events={eventRows}
        metrics={{
          pages: job.page_count ?? pages.length,
          blocks: job.block_count ?? blocks.length,
          imported: job.imported_questions ?? outputs.length,
          reviewItems: job.review_item_count ?? reviewItems.length
        }}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>人工复核</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {reviewItems.length === 0 ? (
              <p className="text-sm text-slate-500">暂无复核项。</p>
            ) : reviewRows.map((item) => (
              <div key={item.id} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 font-medium">
                    <AlertTriangle className="size-4 text-orange-600" />
                    {item.code}
                  </div>
                  <span className="rounded bg-slate-100 px-2 py-1 text-xs">{item.status}</span>
                </div>
                <pre className="mt-2 max-h-28 overflow-auto rounded bg-slate-50 p-2 text-xs text-slate-600">{item.payload_json}</pre>
                {item.status === 'open' && (
                  <form action={resolveReviewItemAction.bind(null, id, item.id)} className="mt-3 flex gap-2">
                    <input name="note" placeholder="处理备注" className="h-9 flex-1 rounded-md border px-3 text-sm" />
                    <Button size="sm" type="submit"><CheckCircle2 className="size-4" />解决</Button>
                  </form>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>输出</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {outputs.length === 0 ? (
              <p className="text-sm text-slate-500">暂无生成题目或题组。</p>
            ) : outputRows.map((output) => (
              <div key={output.id} className="rounded-md border p-3 text-sm">
                <div className="font-medium">{output.output_kind} #{output.question_id ?? output.group_id}</div>
                {output.question_id && <Link href={`/questions/${output.question_id}`} className="mt-1 inline-block text-slate-500 hover:underline">查看题目</Link>}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>区块</CardTitle>
          </CardHeader>
          <CardContent className="max-h-96 space-y-2 overflow-auto">
            {blocks.length === 0 ? <p className="text-sm text-slate-500">暂无区块。</p> : blockRows.map((block) => (
              <div key={block.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="font-medium">{block.block_id} · {block.status}</div>
                <div className="text-slate-500">page {block.page_start ?? '-'}-{block.page_end ?? '-'}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
