import Link from 'next/link';
import { Plus, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
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
  if (urlParams.get('subject') === 'all') urlParams.delete('subject');
  const [banks, subjects] = await Promise.all([listBanks(user, urlParams), listSubjects()]);
  const subjectValue = urlParams.get('subject') ?? 'all';
  const scopeValue = urlParams.get('scope') ?? 'all';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">题库</h1>
          <p className="text-sm text-muted-foreground">创建、收藏、搜索和维护题库。</p>
        </div>
        <Button asChild>
          <Link href="/banks/new"><Plus className="size-4" />新建题库</Link>
        </Button>
      </div>

      <Card>
        <CardContent className="p-4">
          <form className="grid gap-3 md:grid-cols-[1fr_180px_140px_auto]">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input name="q" placeholder="搜索题库名称" defaultValue={urlParams.get('q') ?? ''} className="pl-9" />
            </div>
            <Select name="subject" defaultValue={subjectValue}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="全部学科" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">全部学科</SelectItem>
                  {subjects.map((subject) => (
                    <SelectItem key={subject.subject_id} value={subject.subject_id}>
                      {subject.display_name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select name="scope" defaultValue={scopeValue}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="全部可见" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">全部可见</SelectItem>
                  <SelectItem value="mine">我的</SelectItem>
                  <SelectItem value="favorites">收藏</SelectItem>
                  <SelectItem value="public">公开</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
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
                <Badge variant="secondary">{bank.subject}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">{bank.description || '暂无描述'}</p>
              <div className="flex items-center justify-between text-sm">
                <span>{bank.total_count} 题</span>
                <Badge variant="outline">{bank.is_public ? '公开' : '私有'}</Badge>
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
