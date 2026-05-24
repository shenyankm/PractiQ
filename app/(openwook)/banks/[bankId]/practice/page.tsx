import { notFound } from 'next/navigation';
import { Play, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getBankPracticeSummary } from '@/lib/openwook/services';
import { startPracticeAction } from '../../actions';

export default async function PracticeSetupPage({ params }: { params: Promise<{ bankId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const { bankId } = await params;
  const id = Number(bankId);
  if (!Number.isInteger(id)) notFound();

  const { bank, activeCount, wrongCount, typeCounts, modeCounts } = await getBankPracticeSummary(user, id);
  const action = startPracticeAction.bind(null, id);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">练习配置</h1>
          <p className="mt-1 text-sm text-slate-500">{bank.name} · 当前可练习 {activeCount} 题</p>
        </div>
        <div className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-600">{bank.subject}</div>
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
          <CardContent className="space-y-3">
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
            {activeCount === 0 && <p className="text-sm text-slate-500">发布题目后可开始练习。</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function PracticeSetupForm({
  action,
  activeCount,
  typeCounts,
  wrongCount
}: {
  action: (formData: FormData) => void | Promise<void>;
  activeCount: number;
  typeCounts: Record<string, number>;
  wrongCount: number;
}) {
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="mode">模式</Label>
          <select id="mode" name="mode" className="h-9 w-full rounded-md border bg-white px-3 text-sm">
            <option value="all">全量练习</option>
            <option value="wrong">错题集练习</option>
            <option value="by_type">按题型练习</option>
            <option value="exam">自测模考</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="questionCount">题目数量</Label>
          <Input id="questionCount" name="questionCount" type="number" min={1} max={Math.max(activeCount, 1)} defaultValue={activeCount || 10} />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <input name="allQuestions" type="checkbox" defaultChecked />
          全量练习时使用全部题目
        </label>
        <div className="space-y-2">
          <Label htmlFor="questionTypeId">题型</Label>
          <select id="questionTypeId" name="questionTypeId" className="h-9 w-full rounded-md border bg-white px-3 text-sm">
            <option value="">选择题型</option>
            {Object.entries(typeCounts).map(([typeId, count]) => (
              <option key={typeId} value={typeId}>{typeId} ({count})</option>
            ))}
          </select>
        </div>
      </div>
      <input type="hidden" name="sessionType" value="practice" />
      <div className="rounded-md border px-3 py-2 text-sm text-slate-600">错题集：{wrongCount} 题</div>
      <Button type="submit" disabled={activeCount === 0}>
        <Play className="size-4" />
        开始
      </Button>
    </form>
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
