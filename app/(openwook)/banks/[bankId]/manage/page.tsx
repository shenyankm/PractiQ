import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLink, FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@/components/ui/tooltip';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getBankWithItems, listQuestionTypes } from '@/lib/openwook/services';
import { createQuestionAction } from '../../actions';
import { NewQuestionForm } from './new-question-form';

export default async function BankManagePage({ params }: { params: Promise<{ bankId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const { bankId } = await params;
  const id = Number(bankId);
  if (!Number.isInteger(id)) notFound();
  const { bank, items } = await getBankWithItems(user, id, new URLSearchParams({ limit: '100' }));
  if (!bank.is_owner) notFound();

  const types = await listQuestionTypes(bank.subject, 'question');
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
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileQuestion />
                  </EmptyMedia>
                  <EmptyTitle>暂无题目</EmptyTitle>
                  <EmptyDescription>在右侧新增题目，或回到题库详情页导入现有资料。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : items.map((item) => (
              <div key={`${item.item_scope}-${item.question_id}`} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{item.stem}</div>
                    <div className="mt-1 text-sm text-muted-foreground">{item.question_type_id} · {item.answer_mode} · {item.question_status}</div>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button asChild size="icon" variant="ghost">
                        <Link href={`/questions/${item.question_id}`} aria-label="查看题目">
                          <ExternalLink className="size-4" />
                        </Link>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>查看题目</TooltipContent>
                  </Tooltip>
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
          <NewQuestionForm action={action} types={types} />
        </CardContent>
      </Card>
    </div>
  );
}
