import { Card, Link, Typography } from '@heroui/react';
import { PageState } from '@/components/PageState';
import { useApiResource } from '@/lib/use-api-resource';
import type { AnalyticsSummary, Bank, ImportJob, PracticeSession } from '@/lib/types';

const emptySummary: AnalyticsSummary = {
  owned_banks: 0,
  favorite_banks: 0,
  attempts: 0,
  correct: 0,
  wrong: 0,
  sessions: 0,
  active_sessions: 0,
  active_imports: 0,
  accuracy: 0
};

export default function DashboardPage() {
  const summary = useApiResource('/api/v1/analytics/me/summary', emptySummary);
  const banks = useApiResource<Bank[]>('/api/v1/banks?scope=mine&limit=5', []);
  const sessions = useApiResource<PracticeSession[]>('/api/v1/practice-sessions?limit=5', []);
  const imports = useApiResource<ImportJob[]>('/api/v1/import-jobs?status=processing,failed', []);
  const loading = summary.loading || banks.loading || sessions.loading || imports.loading;
  const error = summary.error || banks.error || sessions.error || imports.error;
  const reload = () => void Promise.all([summary.reload(), banks.reload(), sessions.reload(), imports.reload()]);

  return (
    <section className="grid gap-6">
      <Typography.Heading level={1}>学习概览</Typography.Heading>
      <PageState loading={loading} error={error} retry={reload} />
      {!loading && !error ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ['我的题库', summary.data.owned_banks],
              ['练习次数', summary.data.sessions],
              ['答题数', summary.data.attempts],
              ['正确率', `${summary.data.accuracy}%`]
            ].map(([label, value]) => (
              <Card key={label}>
                <Card.Content>
                  <p className="text-sm text-muted">{label}</p>
                  <p className="text-2xl font-semibold tabular-nums">{value}</p>
                </Card.Content>
              </Card>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <Card.Header><Typography.Heading level={2}>最近题库</Typography.Heading></Card.Header>
              <Card.Content className="grid gap-2">
                {banks.data.map((bank) => <Link key={bank.id} href={`/banks/${bank.id}`}>{bank.name}</Link>)}
                {!banks.data.length ? <p>还没有题库。</p> : null}
              </Card.Content>
            </Card>
            <Card>
              <Card.Header><Typography.Heading level={2}>最近练习</Typography.Heading></Card.Header>
              <Card.Content className="grid gap-2">
                {sessions.data.map((session) => (
                  <Link key={session.id} href={`/practice/${session.id}`}>
                    #{session.id} · {session.answered_count}/{session.question_count}
                  </Link>
                ))}
                {!sessions.data.length ? <p>还没有练习记录。</p> : null}
              </Card.Content>
            </Card>
            <Card>
              <Card.Header><Typography.Heading level={2}>需要关注</Typography.Heading></Card.Header>
              <Card.Content className="grid gap-2">
                {imports.data.map((job) => <Link key={job.id} href={`/imports/${job.id}`}>{job.file_name || `任务 #${job.id}`} · {job.status}</Link>)}
                {!imports.data.length ? <p>没有失败或进行中的导入。</p> : null}
              </Card.Content>
            </Card>
          </div>
        </>
      ) : null}
    </section>
  );
}
