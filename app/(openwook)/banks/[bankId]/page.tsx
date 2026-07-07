import { BookOpen } from 'lucide-react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getBankWithItems } from '@/lib/openwook/services';
import { favoriteBankAction } from '../actions';
import { Badge } from '@heroui/react/badge';
import { Button } from '@heroui/react/button';
import { Card, CardContent, CardHeader, CardTitle } from '@heroui/react/card';
import { EmptyState } from '@heroui/react/empty-state';

export default async function BankDetailPage({ params }: { params: Promise<{ bankId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const { bankId } = await params;
  const id = Number(bankId);
  if (!Number.isInteger(id)) notFound();
  const { bank, items } = await getBankWithItems(user, id, new URLSearchParams({ limit: '30' }));

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="面包屑">
        <ol className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <li><Link href="/banks" className="hover:text-foreground">题库</Link></li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-foreground">{bank.name}</li>
        </ol>
      </nav>

      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{bank.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{bank.description || '暂无描述'}</p>
          <div className="mt-3 flex gap-2">
            <Badge variant="secondary">{bank.subject}</Badge>
            <Badge variant="soft">{bank.is_public ? '公开' : '私有'}</Badge>
            <Badge variant="soft">{bank.total_count} 题</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <form action={favoriteBankAction.bind(null, id, !bank.is_favorite)}>
            <Button variant="outline" type="submit">{bank.is_favorite ? '取消收藏' : '收藏'}</Button>
          </form>
          <Link href={`/banks/${id}/practice`} className="button button--primary">
  开始练习
</Link>
          {bank.is_owner && <Link href={`/banks/${id}/manage`} className="button button--outline">
  管理题目
</Link>}
          {bank.is_owner && <Link href={`/imports?bankId=${id}`} className="button button--outline">
  导入题目
</Link>}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>题目列表</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {items.length === 0 ? (
            <EmptyState>
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
                  <BookOpen />
                </div>
                <h3 className="text-base font-semibold">题库暂无题目</h3>
                <p className="text-sm text-muted-foreground">导入题目或进入管理页手动新增题目后即可开始练习。</p>
              </div>
              {bank.is_owner ? (
                <div className="mt-4 flex justify-center">
                  <div className="flex flex-wrap justify-center gap-2">
                    <Link href={`/imports?bankId=${id}`} className="button button--primary">
  导入题目
</Link>
                    <Link href={`/banks/${id}/manage`} className="button button--outline">
  手动新增
</Link>
                  </div>
                </div>
              ) : null}
            </EmptyState>
          ) : items.map((item) => (
            <Link key={`${item.item_scope}-${item.group_id ?? 'q'}-${item.question_id}`} href={`/questions/${item.question_id}`} className="block rounded-md border p-3 hover:bg-secondary">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-medium">{item.question_no ? `${item.question_no}. ` : ''}{item.stem}</div>
                  {item.group_title && <div className="mt-1 text-sm text-muted-foreground">题组：{item.group_title}</div>}
                </div>
                <Badge variant="secondary">{modeLabel(item.answer_mode)}</Badge>
              </div>
            </Link>
          ))}
        </CardContent>
      </Card>
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
