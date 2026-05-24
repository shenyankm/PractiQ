import Link from 'next/link';
import { FileUp, Play } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
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
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">导入任务</h1>
          <p className="text-sm text-muted-foreground">创建导入作业、查看解析进度和人工复核项。</p>
        </div>
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
                  <Badge variant={statusVariant(job.status)}>{job.risk_level}</Badge>
                </div>
                <Progress className="mt-3" value={job.overall_progress_percent ?? 0} />
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
          <form action={createImportJobAction} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="bankId">目标题库</Label>
              <Select name="bankId" defaultValue={banks[0] ? String(banks[0].id) : undefined} required disabled={banks.length === 0}>
                <SelectTrigger id="bankId" className="w-full">
                  <SelectValue placeholder="选择题库" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {banks.map((bank) => (
                      <SelectItem key={bank.id} value={String(bank.id)}>
                        {bank.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
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
                <Select name="sourceType" defaultValue="txt">
                  <SelectTrigger id="sourceType" className="w-full">
                    <SelectValue placeholder="来源类型" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="txt">TXT</SelectItem>
                      <SelectItem value="docx">DOCX（Plus）</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="parseMode">解析方式</Label>
                <Select name="parseMode" defaultValue="layout">
                  <SelectTrigger id="parseMode" className="w-full">
                    <SelectValue placeholder="解析方式" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="layout">版面解析</SelectItem>
                      <SelectItem value="text">文本解析</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
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

function statusVariant(status: string) {
  if (status === 'failed') return 'destructive';
  if (status === 'processing') return 'default';
  return 'secondary';
}
