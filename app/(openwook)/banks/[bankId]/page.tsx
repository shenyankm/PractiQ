import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getBank, listBankItems } from '@/lib/openwook/services';
import { favoriteBankAction } from '../actions';

export default async function BankDetailPage({ params }: { params: Promise<{ bankId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const { bankId } = await params;
  const id = Number(bankId);
  if (!Number.isInteger(id)) notFound();
  const bank = await getBank(user, id);
  const items = await listBankItems(user, id, new URLSearchParams({ limit: '30' }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{bank.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{bank.description || '暂无描述'}</p>
          <div className="mt-3 flex gap-2">
            <Badge variant="secondary">{bank.subject}</Badge>
            <Badge variant="outline">{bank.is_public ? '公开' : '私有'}</Badge>
            <Badge variant="outline">{bank.total_count} 题</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <form action={favoriteBankAction.bind(null, id, !bank.is_favorite)}>
            <Button variant="outline" type="submit">{bank.is_favorite ? '取消收藏' : '收藏'}</Button>
          </form>
          <Button asChild variant="outline"><Link href={`/banks/${id}/practice`}>开始练习</Link></Button>
          {bank.is_owner && <Button asChild><Link href={`/banks/${id}/manage`}>管理题目</Link></Button>}
          {bank.is_owner && <Button asChild variant="outline"><Link href={`/imports?bankId=${id}`}>导入题目</Link></Button>}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>题目列表</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">题库暂无题目。</p>
          ) : items.map((item) => (
            <Link key={`${item.item_scope}-${item.group_id ?? 'q'}-${item.question_id}`} href={`/questions/${item.question_id}`} className="block rounded-md border p-3 hover:bg-accent">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-medium">{item.question_no ? `${item.question_no}. ` : ''}{item.stem}</div>
                  {item.group_title && <div className="mt-1 text-sm text-muted-foreground">题组：{item.group_title}</div>}
                </div>
                <Badge variant="secondary">{item.answer_mode}</Badge>
              </div>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
