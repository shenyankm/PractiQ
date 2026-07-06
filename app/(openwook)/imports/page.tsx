import { FileUp, Play } from 'lucide-react';
import { Suspense } from 'react';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/openwook/auth';
import { listBanks, listImportJobs } from '@/lib/openwook/services';
import type { ImportJob, QuestionBank } from '@/lib/openwook/types';
import { createImportJobAction } from '../banks/actions';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, ProgressBar } from '@heroui/react';

export default async function ImportsPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  const jobsPromise = listImportJobs(user, new URLSearchParams());
  const banksPromise = listBanks(user, new URLSearchParams({ scope: 'mine', limit: '100' }));

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">导入任务</h1>
          <p className="text-sm text-muted-foreground">创建导入作业、查看解析进度和人工复核项。</p>
        </div>
        <Suspense fallback={<ImportJobsSkeleton />}>
          <ImportJobsList jobsPromise={jobsPromise} />
        </Suspense>
      </div>

      <Suspense fallback={<NewImportSkeleton />}>
        <NewImportForm banksPromise={banksPromise} />
      </Suspense>
    </div>
  );
}

async function ImportJobsList({ jobsPromise }: { jobsPromise: Promise<ImportJob[]> }) {
  const jobs = await jobsPromise;

  return (
    <Card>
      <CardHeader>
        <CardTitle>任务列表</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无导入任务。</p>
        ) : jobs.map((job) => (
          <Link key={job.id} href={`/imports/${job.id}`} className="block rounded-md border p-4 hover:bg-accent">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-medium">{job.file_name || `任务 #${job.id}`}</div>
                <div className="mt-1 text-sm text-muted-foreground">{job.source_type || 'unknown'} · {job.status} · {job.stage}</div>
              </div>
              <Badge variant="secondary" color={statusColor(job.status)}>{job.risk_level}</Badge>
            </div>
            <ProgressBar className="mt-3" value={job.overall_progress_percent ?? 0} />
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

async function NewImportForm({ banksPromise }: { banksPromise: Promise<QuestionBank[]> }) {
  const banks = await banksPromise;

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FileUp className="size-4" />新建导入</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={createImportJobAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="bankId">目标题库</Label>
            <select id="bankId" className="w-full" name="bankId" defaultValue={banks[0] ? String(banks[0].id) : undefined} required disabled={banks.length === 0}>
{banks.map((bank) => (
                    <option key={bank.id} value={String(bank.id)}>
                      {bank.name}
                    </option>
                  ))}
</select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sourceFile">原件</Label>
            <Input
              id="sourceFile"
              name="sourceFile"
              type="file"
              required
              accept=".txt,.docx,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="fileName">文件名</Label>
            <Input id="fileName" name="fileName" placeholder="algebra.txt" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="sourceType">来源类型</Label>
              <select id="sourceType" className="w-full" name="sourceType" defaultValue="txt">
<option value="txt">TXT</option>
                    <option value="docx">DOCX（Plus）</option>
</select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="parseMode">解析方式</Label>
              <select id="parseMode" className="w-full" name="parseMode" defaultValue="layout">
<option value="layout">版面解析</option>
                    <option value="text">文本解析</option>
</select>
            </div>
          </div>
          <Input name="defaultQuestionTypeId" placeholder="默认题型 ID，可选" />
          <Button type="submit" isDisabled={banks.length === 0}>
            <Play className="size-4" />
            创建任务
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ImportJobsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>任务列表</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-md border p-4">
            <div className="h-4 w-40 rounded-md bg-accent" />
            <div className="mt-2 h-3 w-28 rounded-md bg-accent" />
            <div className="mt-3 h-2 rounded-md bg-accent" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function NewImportSkeleton() {
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FileUp className="size-4" />新建导入</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-10 rounded-md bg-accent" />
        ))}
      </CardContent>
    </Card>
  );
}

function statusColor(status: string) {
  if (status === 'failed') return 'danger';
  if (status === 'completed') return 'success';
  if (status === 'processing') return 'accent';
  return 'default';
}
