import Link from 'next/link';
import { FileUp, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getCurrentUser } from '@/lib/openwook/auth';
import { listBanks, listImportJobs } from '@/lib/openwook/services';
import { createImportJobAction } from '../banks/actions';

export default async function ImportsPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  const [jobs, banks] = await Promise.all([
    listImportJobs(user, new URLSearchParams()),
    listBanks(user, new URLSearchParams({ scope: 'mine', limit: '100' }))
  ]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">导入任务</h1>
          <p className="text-sm text-slate-500">创建导入作业、查看解析进度和人工复核项。</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>任务列表</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {jobs.length === 0 ? (
              <p className="text-sm text-slate-500">暂无导入任务。</p>
            ) : jobs.map((job) => (
              <Link key={job.id} href={`/imports/${job.id}`} className="block rounded-md border p-4 hover:bg-slate-50">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="font-medium">{job.file_name || `任务 #${job.id}`}</div>
                    <div className="mt-1 text-sm text-slate-500">{job.source_type || 'unknown'} · {job.status} · {job.stage}</div>
                  </div>
                  <span className={statusClass(job.status)}>{job.risk_level}</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded bg-slate-100">
                  <div className="h-full bg-orange-600" style={{ width: `${job.overall_progress_percent ?? 0}%` }} />
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileUp className="size-4" />新建导入</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createImportJobAction} encType="multipart/form-data" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="bankId">目标题库</Label>
              <select id="bankId" name="bankId" required className="h-9 w-full rounded-md border bg-white px-3 text-sm">
                {banks.map((bank) => (
                  <option key={bank.id} value={bank.id}>{bank.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sourceFile">原件</Label>
              <Input
                id="sourceFile"
                name="sourceFile"
                type="file"
                required
                accept=".txt,.docx,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fileName">文件名</Label>
              <Input id="fileName" name="fileName" placeholder="algebra.txt" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="sourceType">来源类型</Label>
                <select id="sourceType" name="sourceType" className="h-9 w-full rounded-md border bg-white px-3 text-sm">
                  <option value="txt">TXT</option>
                  <option value="docx">DOCX（Plus）</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="parseMode">解析方式</Label>
                <select id="parseMode" name="parseMode" className="h-9 w-full rounded-md border bg-white px-3 text-sm">
                  <option value="layout">版面解析</option>
                  <option value="text">文本解析</option>
                </select>
              </div>
            </div>
            <Input name="defaultQuestionTypeId" placeholder="默认题型 ID，可选" />
            <Button type="submit" disabled={banks.length === 0}>
              <Play className="size-4" />
              创建任务
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function statusClass(status: string) {
  const base = 'rounded px-2 py-1 text-xs';
  if (status === 'failed') return `${base} bg-red-100 text-red-700`;
  if (status === 'completed') return `${base} bg-emerald-100 text-emerald-700`;
  if (status === 'processing') return `${base} bg-orange-100 text-orange-700`;
  return `${base} bg-slate-100 text-slate-700`;
}
