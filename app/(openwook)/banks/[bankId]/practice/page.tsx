import { SlidersHorizontal } from 'lucide-react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getBankPracticeSummary } from '@/lib/openwook/services';
import { startPracticeAction } from '../../actions';
import { PracticeSetupForm } from './practice-setup-form';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@heroui/react';

export { PracticeSetupForm };

export default async function PracticeSetupPage({ params }: { params: Promise<{ bankId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const { bankId } = await params;
  const id = Number(bankId);
  if (!Number.isInteger(id)) notFound();

  const { bank, activeCount, wrongCount, typeCounts, modeCounts } = await getBankPracticeSummary(user, id);
  const action = startPracticeAction.bind(null, id);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <nav aria-label="面包屑">
        <ol className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <li><Link href="/banks" className="hover:text-foreground">题库</Link></li>
          <li aria-hidden="true">/</li>
          <li><Link href={`/banks/${id}`} className="hover:text-foreground">{bank.name}</Link></li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-foreground">练习配置</li>
        </ol>
      </nav>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">练习配置</h1>
          <p className="mt-1 text-sm text-muted-foreground">{bank.name} · 当前可练习 {activeCount} 题</p>
        </div>
        <Badge variant="secondary">{bank.subject}</Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-[1fr_280px]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><SlidersHorizontal className="size-4" />会话参数</CardTitle>
          </CardHeader>
          <CardContent>
            <PracticeSetupForm action={action} activeCount={activeCount} typeCounts={typeCounts} wrongCount={wrongCount} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>题型分布</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {Object.entries(modeCounts).map(([mode, count]) => (
              <div key={mode} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span>{modeLabel(mode)}</span>
                <span className="font-medium">{count}</span>
              </div>
            ))}
            <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>错题练习入口</span>
              <span className="font-medium">{wrongCount} 题</span>
            </div>
            {activeCount === 0 && <p className="text-sm text-muted-foreground">发布题目后可开始练习。</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function modeLabel(mode: string) {
  return {
    choice: '选择题',
    true_false: '判断题',
    fill_blank: '填空题',
    short_answer: '简答题'
  }[mode] ?? mode;
}
