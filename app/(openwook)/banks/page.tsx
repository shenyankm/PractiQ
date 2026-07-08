import type { Metadata } from 'next';
import { BookOpen, Plus } from 'lucide-react';
import { Suspense } from 'react';
import {
  Link,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  FieldGroup,
  Input,
  Label,
  Select,
  ListBox
} from '@heroui/react';
import { getCurrentUser } from '@/lib/openwook/auth';
import { listBanks, listSubjects } from '@/lib/openwook/services';
import type { Subject } from '@/lib/openwook/types';
import { buttonVariants } from '@heroui/styles';

export const metadata: Metadata = {
  title: '题库'
};

export default async function BanksPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) return null;
  const params = await searchParams;
  const urlParams = normalizeBankSearchParams(params);
  const subjectValue = urlParams.get('subject') ?? 'all';
  const scopeValue = urlParams.get('scope') ?? 'all';
  const subjectsPromise = listSubjects();
  const banksPromise = listBanks(user, urlParams);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">题库</h1>
          <p className="text-sm text-muted-foreground">创建、收藏、搜索和维护题库。</p>
        </div>
        <Link href="/banks/new" className={buttonVariants({ variant: 'primary' })}>
  <Plus className="size-4" />新建题库
</Link>
      </div>

      <Suspense fallback={<BankFiltersSkeleton />}>
        <BankFilters
          subjectsPromise={subjectsPromise}
          q={urlParams.get('q') ?? ''}
          subjectValue={subjectValue}
          scopeValue={scopeValue}
        />
      </Suspense>

      <Suspense fallback={<BankGridSkeleton />}>
        <BankGrid banksPromise={banksPromise} />
      </Suspense>
    </div>
  );
}

function normalizeBankSearchParams(params: Record<string, string | string[] | undefined>) {
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') urlParams.set(key, value);
  }
  urlParams.set('scope', urlParams.get('scope') || 'all');
  if (urlParams.get('subject') === 'all') urlParams.delete('subject');

  return urlParams;
}

async function BankFilters({
  subjectsPromise,
  q,
  subjectValue,
  scopeValue
}: {
  subjectsPromise: Promise<Subject[]>;
  q: string;
  subjectValue: string;
  scopeValue: string;
}) {
  const subjects = await subjectsPromise;

  return (
    <Card>
      <CardContent className="p-4">
        <form className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_140px_auto_auto] md:items-end">
          <div className="gap-2">
            <Label htmlFor="bank-search" className="sr-only">搜索题库</Label>
            <Input id="bank-search" name="q" placeholder="搜索题库名称" defaultValue={q} />
          </div>
          <div className="gap-2">
            <Label htmlFor="bank-subject" className="sr-only">学科</Label>
            <Select name="subject" defaultSelectedKey={subjectValue}>
              <Label>学科</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="all">全部学科</ListBox.Item>
                  {subjects.map((subject) => (
                    <ListBox.Item key={subject.subject_id} id={subject.subject_id}>
                      {subject.display_name}
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
          <div className="gap-2">
            <Label htmlFor="bank-scope" className="sr-only">范围</Label>
            <Select name="scope" defaultSelectedKey={scopeValue}>
              <Label>范围</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="all">全部可见</ListBox.Item>
                  <ListBox.Item id="mine">我的</ListBox.Item>
                  <ListBox.Item id="favorites">收藏</ListBox.Item>
                  <ListBox.Item id="public">公开</ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
          <Button type="submit" variant="outline">筛选</Button>
          <Link href="/banks" className={buttonVariants({ variant: 'ghost' })}>
  重置
</Link>
        </form>
      </CardContent>
    </Card>
  );
}

async function BankGrid({ banksPromise }: { banksPromise: ReturnType<typeof listBanks> }) {
  const banks = await banksPromise;

  if (banks.length === 0) {
    return (
      <EmptyState className="border">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
            <BookOpen />
          </div>
          <h3 className="text-base font-semibold">没有匹配的题库</h3>
          <p className="text-sm text-muted-foreground">
            调整搜索或筛选条件，或创建一个新的题库开始整理题目。
          </p>
        </div>
        <div className="mt-4 flex justify-center">
          <FieldGroup className="gap-3">
            <Link href="/banks/new" className={buttonVariants({ variant: 'primary' })}>
  新建题库
</Link>
            <Link href="/banks" className={buttonVariants({ variant: 'outline' })}>
  清除筛选
</Link>
          </FieldGroup>
        </div>
      </EmptyState>
    );
  }

  return (
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
              <Badge variant="soft">{bank.is_public ? '公开' : '私有'}</Badge>
            </div>
            <div className="flex gap-2">
              <Link href={`/banks/${bank.id}/practice`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
  练习
</Link>
              {bank.is_owner && <Link href={`/banks/${bank.id}/manage`} className={buttonVariants({ variant: 'primary', size: 'sm' })}>
  管理
</Link>}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function BankFiltersSkeleton() {
  return (
    <Card>
      <CardContent className="grid gap-3 p-4 md:grid-cols-[1fr_180px_140px_auto]">
        <div className="h-9 rounded-md bg-secondary" />
        <div className="h-9 rounded-md bg-secondary" />
        <div className="h-9 rounded-md bg-secondary" />
        <div className="h-9 rounded-md bg-secondary" />
      </CardContent>
    </Card>
  );
}

function BankGridSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <Card key={index} className="gap-4">
          <CardHeader>
            <div className="h-5 w-40 rounded-md bg-secondary" />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="h-10 rounded-md bg-secondary" />
            <div className="h-4 w-28 rounded-md bg-secondary" />
            <div className="h-8 w-32 rounded-md bg-secondary" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
