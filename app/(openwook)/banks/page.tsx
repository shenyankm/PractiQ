import Link from 'next/link';
import { Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getCurrentUser } from '@/lib/openwook/auth';
import { listBanks, listSubjects } from '@/lib/openwook/services';

export default async function BanksPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) return null;
  const params = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') urlParams.set(key, value);
  }
  urlParams.set('scope', urlParams.get('scope') || 'all');
  const [banks, subjects] = await Promise.all([listBanks(user, urlParams), listSubjects()]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">题库</h1>
          <p className="text-sm text-slate-500">创建、收藏、搜索和维护题库。</p>
        </div>
        <Button asChild>
          <Link href="/banks/new"><Plus className="size-4" />新建题库</Link>
        </Button>
      </div>

      <Card>
        <CardContent className="p-4">
          <form className="grid gap-3 md:grid-cols-[1fr_180px_140px_auto]">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 size-4 text-slate-400" />
              <Input name="q" placeholder="搜索题库名称" defaultValue={urlParams.get('q') ?? ''} className="pl-9" />
            </div>
            <select name="subject" defaultValue={urlParams.get('subject') ?? ''} className="h-9 rounded-md border bg-white px-3 text-sm">
              <option value="">全部学科</option>
              {subjects.map((subject) => (
                <option key={subject.subject_id} value={subject.subject_id}>{subject.display_name}</option>
              ))}
            </select>
            <select name="scope" defaultValue={urlParams.get('scope') ?? 'all'} className="h-9 rounded-md border bg-white px-3 text-sm">
              <option value="all">全部可见</option>
              <option value="mine">我的</option>
              <option value="favorites">收藏</option>
              <option value="public">公开</option>
            </select>
            <Button type="submit" variant="outline">筛选</Button>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {banks.map((bank) => (
          <Card key={bank.id} className="gap-4">
            <CardHeader>
              <CardTitle className="flex items-start justify-between gap-3">
                <Link href={`/banks/${bank.id}`} className="hover:underline">{bank.name}</Link>
                <span className="rounded bg-slate-100 px-2 py-1 text-xs font-normal text-slate-600">{bank.subject}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="line-clamp-2 min-h-10 text-sm text-slate-500">{bank.description || '暂无描述'}</p>
              <div className="flex items-center justify-between text-sm">
                <span>{bank.total_count} 题</span>
                <span>{bank.is_public ? '公开' : '私有'}</span>
              </div>
              <div className="flex gap-2">
                <Button asChild size="sm" variant="outline"><Link href={`/banks/${bank.id}/practice`}>练习</Link></Button>
                {bank.is_owner && <Button asChild size="sm"><Link href={`/banks/${bank.id}/manage`}>管理</Link></Button>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
