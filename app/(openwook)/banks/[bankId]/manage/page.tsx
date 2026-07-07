import { ExternalLink, FileQuestion } from 'lucide-react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getBankWithItems, listQuestionTypes } from '@/lib/openwook/services';
import { createQuestionAction } from '../../actions';
import { NewQuestionForm } from './new-question-form';
import { Card, CardContent, CardHeader, CardTitle } from '@heroui/react/card';
import { EmptyState } from '@heroui/react/empty-state';
import { Tooltip } from '@heroui/react/tooltip';

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
              <EmptyState>
                <div className="flex flex-col items-center gap-2 text-center">
                  <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
                    <FileQuestion />
                  </div>
                  <h3 className="text-base font-semibold">暂无题目</h3>
                  <p className="text-sm text-muted-foreground">在右侧新增题目，或回到题库详情页导入现有资料。</p>
                </div>
              </EmptyState>
            ) : items.map((item) => (
              <div key={`${item.item_scope}-${item.question_id}`} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{item.stem}</div>
                    <div className="mt-1 text-sm text-muted-foreground">{item.question_type_id} · {item.answer_mode} · {item.question_status}</div>
                  </div>
                  <Tooltip>
                    <Link href={`/questions/${item.question_id}`} aria-label="查看题目" className="button button--ghost button--icon">
                      <ExternalLink className="size-4" />
                    </Link>
                    <Tooltip.Content>查看题目</Tooltip.Content>
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
