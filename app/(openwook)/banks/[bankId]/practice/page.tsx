import { notFound } from 'next/navigation';
import { Play, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getBank, listBankItems } from '@/lib/openwook/services';
import { startPracticeAction } from '../../actions';

export default async function PracticeSetupPage({ params }: { params: Promise<{ bankId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const { bankId } = await params;
  const id = Number(bankId);
  if (!Number.isInteger(id)) notFound();

  const [bank, activeItems] = await Promise.all([
    getBank(user, id),
    listBankItems(user, id, new URLSearchParams({ status: 'active', limit: '100' }))
  ]);
  const action = startPracticeAction.bind(null, id);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">练习配置</h1>
          <p className="mt-1 text-sm text-slate-500">{bank.name} · 当前可练习 {activeItems.length} 题</p>
        </div>
        <div className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-600">{bank.subject}</div>
      </div>

      <div className="grid gap-4 md:grid-cols-[1fr_280px]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><SlidersHorizontal className="size-4" />会话参数</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={action} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="sessionType">模式</Label>
                  <select id="sessionType" name="sessionType" className="h-9 w-full rounded-md border bg-white px-3 text-sm">
                    <option value="practice">练习</option>
                    <option value="review">复习</option>
                    <option value="exam">测验</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="questionCount">题目数量</Label>
                  <Input id="questionCount" name="questionCount" type="number" min={1} max={Math.max(activeItems.length, 1)} defaultValue={Math.min(activeItems.length || 10, 10)} />
                </div>
              </div>
              <Button type="submit" disabled={activeItems.length === 0}>
                <Play className="size-4" />
                开始练习
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>题型分布</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.entries(countBy(activeItems.map((item) => item.answer_mode))).map(([mode, count]) => (
              <div key={mode} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span>{modeLabel(mode)}</span>
                <span className="font-medium">{count}</span>
              </div>
            ))}
            {activeItems.length === 0 && <p className="text-sm text-slate-500">发布题目后可开始练习。</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function modeLabel(mode: string) {
  return {
    choice: '选择题',
    true_false: '判断题',
    fill_blank: '填空题',
    short_answer: '简答题'
  }[mode] ?? mode;
}
