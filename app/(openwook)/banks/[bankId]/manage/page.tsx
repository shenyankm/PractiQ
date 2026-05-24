import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getBank, listBankItems, listQuestionTypes } from '@/lib/openwook/services';
import { createQuestionAction } from '../../actions';

export default async function BankManagePage({ params }: { params: Promise<{ bankId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const { bankId } = await params;
  const id = Number(bankId);
  if (!Number.isInteger(id)) notFound();
  const bank = await getBank(user, id);
  if (!bank.is_owner) notFound();

  const [items, types] = await Promise.all([
    listBankItems(user, id, new URLSearchParams({ limit: '100' })),
    listQuestionTypes(bank.subject, 'question')
  ]);
  const action = createQuestionAction.bind(null, id);

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">管理题库：{bank.name}</h1>
          <p className="text-sm text-slate-500">维护题目、答案和发布状态。</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>已有题目</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {items.length === 0 ? (
              <p className="text-sm text-slate-500">暂无题目。</p>
            ) : items.map((item) => (
              <div key={`${item.item_scope}-${item.question_id}`} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{item.stem}</div>
                    <div className="mt-1 text-sm text-slate-500">{item.question_type_id} · {item.answer_mode} · {item.question_status}</div>
                  </div>
                  <Button asChild size="icon" variant="ghost" title="查看题目">
                    <Link href={`/questions/${item.question_id}`}><ExternalLink className="size-4" /></Link>
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>新增题目</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-4">
            <div className="space-y-2">
              <Label>题型</Label>
              <select name="questionTypeId" className="h-9 w-full rounded-md border bg-white px-3 text-sm">
                {types.map((type) => (
                  <option key={type.type_id} value={type.type_id}>{type.display_name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>答题模式</Label>
              <select name="answerMode" className="h-9 w-full rounded-md border bg-white px-3 text-sm">
                <option value="choice">选择题</option>
                <option value="true_false">判断题</option>
                <option value="fill_blank">填空题</option>
                <option value="short_answer">简答题</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>题干</Label>
              <textarea name="stem" rows={5} required className="w-full rounded-md border bg-white px-3 py-2 text-sm" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label>选项 A</Label>
                <Input name="optionA" />
              </div>
              <div className="space-y-2">
                <Label>选项 B</Label>
                <Input name="optionB" />
              </div>
              <div className="space-y-2">
                <Label>选项 C</Label>
                <Input name="optionC" />
              </div>
              <div className="space-y-2">
                <Label>选项 D</Label>
                <Input name="optionD" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>选择题正确选项</Label>
              <select name="correctOption" defaultValue="A" className="h-9 w-full rounded-md border bg-white px-3 text-sm">
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
                <option value="D">D</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>非选择题正确答案/参考答案</Label>
              <Input name="answer" placeholder="判断题填写 true 或 false" />
            </div>
            <div className="space-y-2">
              <Label>解析</Label>
              <textarea name="analysis" rows={3} className="w-full rounded-md border bg-white px-3 py-2 text-sm" />
            </div>
            <div className="flex gap-3">
              <select name="status" defaultValue="draft" className="h-9 rounded-md border bg-white px-3 text-sm">
                <option value="draft">草稿</option>
                <option value="active">发布</option>
              </select>
              <Button type="submit">保存题目</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
