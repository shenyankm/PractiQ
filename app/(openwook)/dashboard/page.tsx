import Link from 'next/link';
import { BookOpen, CheckCircle2, FileWarning, Plus, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentUser } from '@/lib/openwook/auth';
import { listBanks, listImportJobs } from '@/lib/openwook/services';
import { sql } from '@/lib/openwook/db';

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [banks, imports, stats] = await Promise.all([
    listBanks(user, new URLSearchParams({ scope: 'mine', limit: '5' })),
    listImportJobs(user, new URLSearchParams({ status: 'queued,processing,failed' })),
    sql<Array<{ attempts: number; correct: number; sessions: number }>>`
      SELECT
        COALESCE(SUM(attempt_count), 0)::int AS attempts,
        COALESCE(SUM(correct_count), 0)::int AS correct,
        (SELECT COUNT(*)::int FROM user_practice_sessions WHERE user_id = ${user.id}) AS sessions
      FROM user_question_stats
      WHERE user_id = ${user.id}
    `
  ]);
  const summary = stats[0] ?? { attempts: 0, correct: 0, sessions: 0 };
  const accuracy = summary.attempts ? Math.round((summary.correct / summary.attempts) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">仪表板</h1>
          <p className="text-sm text-slate-500">管理题库、导入任务和练习表现。</p>
        </div>
        <Button asChild>
          <Link href="/banks">进入题库</Link>
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Metric title="我的题库" value={banks.length} icon={BookOpen} />
        <Metric title="练习次数" value={summary.sessions} icon={CheckCircle2} />
        <Metric title="答题数" value={summary.attempts} icon={TrendingUp} />
        <Metric title="正确率" value={`${accuracy}%`} icon={TrendingUp} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>最近题库</CardTitle>
            <Button asChild size="sm" variant="outline">
              <Link href="/banks"><Plus className="size-4" />新建</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {banks.length === 0 ? (
              <p className="text-sm text-slate-500">还没有题库。</p>
            ) : banks.map((bank) => (
              <Link key={bank.id} href={`/banks/${bank.id}`} className="block rounded-md border p-3 hover:bg-slate-50">
                <div className="font-medium">{bank.name}</div>
                <div className="text-sm text-slate-500">{bank.subject} · {bank.total_count} 题</div>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>导入任务</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {imports.length === 0 ? (
              <p className="text-sm text-slate-500">当前没有需要关注的导入任务。</p>
            ) : imports.slice(0, 6).map((job) => (
              <Link key={job.id} href={`/imports/${job.id}`} className="flex items-center gap-3 rounded-md border p-3 hover:bg-slate-50">
                <FileWarning className="size-4 text-orange-600" />
                <div>
                  <div className="font-medium">{job.file_name || `任务 #${job.id}`}</div>
                  <div className="text-sm text-slate-500">{job.status} · {job.stage}</div>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Metric({ title, value, icon: Icon }: { title: string; value: string | number; icon: React.ElementType }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <div className="text-sm text-slate-500">{title}</div>
          <div className="mt-1 text-2xl font-semibold">{value}</div>
        </div>
        <Icon className="size-5 text-orange-600" />
      </CardContent>
    </Card>
  );
}
