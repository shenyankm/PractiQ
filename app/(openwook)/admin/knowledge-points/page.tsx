import Link from 'next/link';
import { Search, Tags } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  Field,
  FieldGroup,
  FieldLabel
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { listAdminKnowledgePoints, listSubjects } from '@/lib/openwook/services';
import { requireAdminPage } from '../admin-auth';
import { AdminNav } from '../admin-nav';
import { createKnowledgePointAction, updateKnowledgePointAction } from '../actions';

export default async function AdminKnowledgePointsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireAdminPage();
  const params = normalizeParams(await searchParams);
  const [subjects, points] = await Promise.all([
    listSubjects(),
    listAdminKnowledgePoints(user, params)
  ]);
  const subjectValue = params.get('subject') ?? 'all';

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">知识点管理</h1>
            <p className="text-sm text-muted-foreground">维护学科知识点编码、名称和元数据。</p>
          </div>
          <Button asChild variant="outline">
            <Link href="/admin">返回后台</Link>
          </Button>
        </div>

        <AdminNav />

        <Card>
          <CardContent className="p-4">
            <form className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_auto_auto] md:items-end">
              <Field className="gap-2">
                <FieldLabel htmlFor="knowledge-point-search" className="sr-only">搜索知识点</FieldLabel>
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                  <Input id="knowledge-point-search" name="q" placeholder="搜索编码或名称" defaultValue={params.get('q') ?? ''} className="pl-9" />
                </div>
              </Field>
              <Field className="gap-2">
                <FieldLabel htmlFor="knowledge-point-subject" className="sr-only">学科</FieldLabel>
                <Select name="subject" defaultValue={subjectValue}>
                  <SelectTrigger id="knowledge-point-subject" className="w-full">
                    <SelectValue placeholder="全部学科" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">全部学科</SelectItem>
                      {subjects.map((subject) => (
                        <SelectItem key={subject.subject_id} value={subject.subject_id}>{subject.display_name}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Button type="submit" variant="outline">筛选</Button>
              <Button asChild variant="ghost">
                <Link href="/admin/knowledge-points">重置</Link>
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Tags className="size-4" />知识点列表</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {points.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Tags />
                  </EmptyMedia>
                  <EmptyTitle>没有匹配的知识点</EmptyTitle>
                  <EmptyDescription>调整搜索或学科筛选，或在右侧创建新的知识点。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : points.map((point) => (
              <form key={point.id} action={updateKnowledgePointAction.bind(null, point.id)} className="grid gap-3 rounded-md border p-4 lg:grid-cols-[140px_1fr_180px_90px] lg:items-end">
                <Field>
                  <FieldLabel htmlFor={`code-${point.id}`}>编码</FieldLabel>
                  <Input id={`code-${point.id}`} name="code" defaultValue={point.code} required />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`displayName-${point.id}`}>名称</FieldLabel>
                  <Input id={`displayName-${point.id}`} name="displayName" defaultValue={point.display_name} required />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`parentId-${point.id}`}>父级 ID</FieldLabel>
                  <Input id={`parentId-${point.id}`} name="parentId" defaultValue={point.parent_id ?? ''} inputMode="numeric" />
                </Field>
                <Button type="submit" variant="outline">保存</Button>
              </form>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>新增知识点</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createKnowledgePointAction}>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="subjectId">学科</FieldLabel>
                <Select name="subjectId" defaultValue={subjects[0]?.subject_id}>
                  <SelectTrigger id="subjectId" className="w-full">
                    <SelectValue placeholder="选择学科" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {subjects.map((subject) => (
                        <SelectItem key={subject.subject_id} value={subject.subject_id}>{subject.display_name}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="code">编码</FieldLabel>
                <Input id="code" name="code" required maxLength={128} placeholder="math.algebra.linear" />
              </Field>
              <Field>
                <FieldLabel htmlFor="displayName">名称</FieldLabel>
                <Input id="displayName" name="displayName" required maxLength={256} />
              </Field>
              <Field>
                <FieldLabel htmlFor="parentId">父级 ID</FieldLabel>
                <Input id="parentId" name="parentId" inputMode="numeric" />
              </Field>
              <Field>
                <FieldLabel htmlFor="metadata">元数据 JSON</FieldLabel>
                <Input id="metadata" name="metadata" placeholder='{"grade":"G7"}' />
              </Field>
              <Button type="submit">创建知识点</Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function normalizeParams(params: Record<string, string | string[] | undefined>) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value && value !== 'all') searchParams.set(key, value);
  }
  return searchParams;
}
