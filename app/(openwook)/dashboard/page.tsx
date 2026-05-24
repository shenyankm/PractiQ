import { Suspense } from 'react';
import Link from 'next/link';
import { BookOpen, CheckCircle2, FileWarning, Plus, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getAnalyticsSummary, listBanks, listImportJobs } from '@/lib/openwook/services';
import type { User } from '@/lib/openwook/types';

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">仪表板</h1>
          <p className="text-sm text-muted-foreground">管理题库、导入任务和练习表现。</p>
        </div>
        <Button asChild>
          <Link href="/banks">进入题库</Link>
        </Button>
      </div>

      <Suspense fallback={<MetricGridSkeleton />}>
        <DashboardMetrics user={user} />
      </Suspense>

      <div className="grid gap-4 lg:grid-cols-2">
        <Suspense fallback={<PanelSkeleton title="最近题库" />}>
          <RecentBanks user={user} />
        </Suspense>

        <Suspense fallback={<PanelSkeleton title="导入任务" />}>
          <ImportAttentionList user={user} />
        </Suspense>
      </div>
    </div>
  );
}

async function DashboardMetrics({ user }: { user: User }) {
  const summary = await getAnalyticsSummary(user);

  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Metric title="我的题库" value={summary.owned_banks} icon={BookOpen} />
      <Metric title="练习次数" value={summary.sessions} icon={CheckCircle2} />
      <Metric title="答题数" value={summary.attempts} icon={TrendingUp} />
      <Metric title="正确率" value={`${summary.accuracy}%`} icon={TrendingUp} />
    </div>
  );
}

async function RecentBanks({ user }: { user: User }) {
  const banks = await listBanks(user, new URLSearchParams({ scope: 'mine', limit: '5' }));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>最近题库</CardTitle>
        <Button asChild size="sm" variant="outline">
          <Link href="/banks"><Plus className="size-4" />新建</Link>
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {banks.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有题库。</p>
        ) : banks.map((bank) => (
          <Link key={bank.id} href={`/banks/${bank.id}`} className="block rounded-md border p-3 hover:bg-accent">
            <div className="font-medium">{bank.name}</div>
            <div className="text-sm text-muted-foreground">{bank.subject} · {bank.total_count} 题</div>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

async function ImportAttentionList({ user }: { user: User }) {
  const imports = await listImportJobs(user, new URLSearchParams({ status: 'queued,processing,failed' }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>导入任务</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {imports.length === 0 ? (
          <p className="text-sm text-muted-foreground">当前没有需要关注的导入任务。</p>
        ) : imports.slice(0, 6).map((job) => (
          <Link key={job.id} href={`/imports/${job.id}`} className="flex items-center gap-3 rounded-md border p-3 hover:bg-accent">
            <FileWarning className="size-4 text-primary" />
            <div>
              <div className="font-medium">{job.file_name || `任务 #${job.id}`}</div>
              <div className="text-sm text-muted-foreground">{job.status} · {job.stage}</div>
            </div>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

function Metric({ title, value, icon: Icon }: { title: string; value: string | number; icon: React.ElementType }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <div className="text-sm text-muted-foreground">{title}</div>
          <div className="mt-1 text-2xl font-semibold">{value}</div>
        </div>
        <Icon className="size-5 text-primary" />
      </CardContent>
    </Card>
  );
}

function MetricGridSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <Card key={index}>
          <CardContent className="p-5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-3 h-8 w-16" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function PanelSkeleton({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="rounded-md border p-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-2 h-3 w-24" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
