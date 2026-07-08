import { AlertTriangle, CheckCircle2, Play, RotateCcw, XCircle } from 'lucide-react';
import { notFound } from 'next/navigation';
import {
  Link,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input
} from '@heroui/react';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getImportJobDetail } from '@/lib/openwook/services';
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

  const { job, events, pages, blocks, reviewItems, outputs } = await getImportJobDetail(user, id);
  const eventRows = events as unknown as EventRow[];
  const blockRows = blocks as unknown as BlockRow[];
  const reviewRows = reviewItems as unknown as ReviewItemRow[];
  const outputRows = outputs as unknown as OutputRow[];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{job.file_name || `导入任务 #${job.id}`}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{job.status} · {job.stage} · 风险 {job.risk_level}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <form action={updateImportStatusAction.bind(null, id, 'start')}>
            <Button size="sm" isDisabled={job.status === 'processing' || job.status === 'completed'}><Play className="size-4" />开始</Button>
          </form>
          <form action={updateImportStatusAction.bind(null, id, 'retry')}>
            <Button size="sm" variant="outline" isDisabled={job.status === 'processing'}><RotateCcw className="size-4" />重试</Button>
          </form>
          <form action={updateImportStatusAction.bind(null, id, 'cancel')}>
            <Button size="sm" variant="outline" isDisabled={job.status === 'completed' || job.status === 'failed'}><XCircle className="size-4" />取消</Button>
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
          <CardContent className="flex flex-col gap-3">
            {reviewItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无复核项。</p>
            ) : reviewRows.map((item) => (
              <div key={item.id} className="rounded-md border border-border/70 bg-background/35 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 font-medium">
                    <AlertTriangle className="size-4 text-foreground" />
                    {item.code}
                  </div>
                  <Badge variant={item.status === 'open' ? 'primary' : 'secondary'}>{item.status}</Badge>
                </div>
                <pre className="mt-2 max-h-28 overflow-auto rounded bg-muted p-2 text-xs text-muted-foreground">{item.payload_json}</pre>
                {item.status === 'open' && (
                  <form action={resolveReviewItemAction.bind(null, id, item.id)} className="mt-3 flex gap-2">
                    <Input name="note" placeholder="处理备注" />
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
          <CardContent className="flex flex-col gap-3">
            {outputs.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无生成题目或题组。</p>
            ) : outputRows.map((output) => (
              <div key={output.id} className="rounded-md border p-3 text-sm">
                <div className="font-medium">{output.output_kind} #{output.question_id ?? output.group_id}</div>
                {output.question_id && <Link href={`/questions/${output.question_id}`} className="mt-1 inline-block text-muted-foreground hover:underline">查看题目</Link>}
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
          <CardContent className="flex max-h-96 flex-col gap-2 overflow-auto">
            {blocks.length === 0 ? <p className="text-sm text-muted-foreground">暂无区块。</p> : blockRows.map((block) => (
              <div key={block.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="font-medium">{block.block_id} · {block.status}</div>
                <div className="text-muted-foreground">page {block.page_start ?? '-'}-{block.page_end ?? '-'}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
