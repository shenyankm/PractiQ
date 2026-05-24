import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
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
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">管理题库：{bank.name}</h1>
          <p className="text-sm text-muted-foreground">维护题目、答案和发布状态。</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>已有题目</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无题目。</p>
            ) : items.map((item) => (
              <div key={`${item.item_scope}-${item.question_id}`} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{item.stem}</div>
                    <div className="mt-1 text-sm text-muted-foreground">{item.question_type_id} · {item.answer_mode} · {item.question_status}</div>
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
          <form action={action} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="questionTypeId">题型</Label>
              <Select name="questionTypeId" defaultValue={types[0]?.type_id}>
                <SelectTrigger id="questionTypeId" className="w-full">
                  <SelectValue placeholder="选择题型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {types.map((type) => (
                      <SelectItem key={type.type_id} value={type.type_id}>
                        {type.display_name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="answerMode">答题模式</Label>
              <Select name="answerMode" defaultValue="choice">
                <SelectTrigger id="answerMode" className="w-full">
                  <SelectValue placeholder="选择答题模式" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="choice">选择题</SelectItem>
                    <SelectItem value="true_false">判断题</SelectItem>
                    <SelectItem value="fill_blank">填空题</SelectItem>
                    <SelectItem value="short_answer">简答题</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="stem">题干</Label>
              <Textarea id="stem" name="stem" rows={5} required />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="optionA">选项 A</Label>
                <Input id="optionA" name="optionA" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="optionB">选项 B</Label>
                <Input id="optionB" name="optionB" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="optionC">选项 C</Label>
                <Input id="optionC" name="optionC" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="optionD">选项 D</Label>
                <Input id="optionD" name="optionD" />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="correctOption">选择题正确选项</Label>
              <Select name="correctOption" defaultValue="A">
                <SelectTrigger id="correctOption" className="w-full">
                  <SelectValue placeholder="选择正确选项" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="A">A</SelectItem>
                    <SelectItem value="B">B</SelectItem>
                    <SelectItem value="C">C</SelectItem>
                    <SelectItem value="D">D</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="answer">非选择题正确答案/参考答案</Label>
              <Input id="answer" name="answer" placeholder="判断题填写 true 或 false" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="analysis">解析</Label>
              <Textarea id="analysis" name="analysis" rows={3} />
            </div>
            <div className="flex gap-3">
              <Select name="status" defaultValue="draft">
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="draft">草稿</SelectItem>
                    <SelectItem value="active">发布</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button type="submit">保存题目</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
