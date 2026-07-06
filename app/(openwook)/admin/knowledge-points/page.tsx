import { Search, Tags } from 'lucide-react';
import Link from 'next/link';
import { listAdminKnowledgePoints, listSubjects } from '@/lib/openwook/services';
import { requireAdminPage } from '../admin-auth';
import { AdminNav } from '../admin-nav';
import { createKnowledgePointAction, updateKnowledgePointAction } from '../actions';
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, FieldGroup, Input, Label } from '@heroui/react';

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
          <Link href="/admin" className="button button--outline">
  返回后台
</Link>
        </div>

        <AdminNav />

        <Card>
          <CardContent className="p-4">
            <form className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_auto_auto] md:items-end">
              <div className="gap-2">
                <Label htmlFor="knowledge-point-search" className="sr-only">搜索知识点</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                  <Input id="knowledge-point-search" name="q" placeholder="搜索编码或名称" defaultValue={params.get('q') ?? ''} className="pl-9" />
                </div>
              </div>
              <div className="gap-2">
                <Label htmlFor="knowledge-point-subject" className="sr-only">学科</Label>
                <select id="knowledge-point-subject" className="w-full" name="subject" defaultValue={subjectValue}>
<option value="all">全部学科</option>
                      {subjects.map((subject) => (
                        <option key={subject.subject_id} value={subject.subject_id}>{subject.display_name}</option>
                      ))}
</select>
              </div>
              <Button type="submit" variant="outline">筛选</Button>
              <Link href="/admin/knowledge-points" className="button button--ghost">
  重置
</Link>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Tags className="size-4" />知识点列表</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {points.length === 0 ? (
              <EmptyState>
                <div className="flex flex-col items-center gap-2 text-center">
                  <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
                    <Tags />
                  </div>
                  <h3 className="text-base font-semibold">没有匹配的知识点</h3>
                  <p className="text-sm text-muted-foreground">调整搜索或学科筛选，或在右侧创建新的知识点。</p>
                </div>
              </EmptyState>
            ) : points.map((point) => (
              <form key={point.id} action={updateKnowledgePointAction.bind(null, point.id)} className="grid gap-3 rounded-md border p-4 lg:grid-cols-[140px_1fr_180px_90px] lg:items-end">
                <div>
                  <Label htmlFor={`code-${point.id}`}>编码</Label>
                  <Input id={`code-${point.id}`} name="code" defaultValue={point.code} required />
                </div>
                <div>
                  <Label htmlFor={`displayName-${point.id}`}>名称</Label>
                  <Input id={`displayName-${point.id}`} name="displayName" defaultValue={point.display_name} required />
                </div>
                <div>
                  <Label htmlFor={`parentId-${point.id}`}>父级 ID</Label>
                  <Input id={`parentId-${point.id}`} name="parentId" defaultValue={point.parent_id ?? ''} inputMode="numeric" />
                </div>
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
              <div>
                <Label htmlFor="subjectId">学科</Label>
                <select id="subjectId" className="w-full" name="subjectId" defaultValue={subjects[0]?.subject_id}>
{subjects.map((subject) => (
                        <option key={subject.subject_id} value={subject.subject_id}>{subject.display_name}</option>
                      ))}
</select>
              </div>
              <div>
                <Label htmlFor="code">编码</Label>
                <Input id="code" name="code" required maxLength={128} placeholder="math.algebra.linear" />
              </div>
              <div>
                <Label htmlFor="displayName">名称</Label>
                <Input id="displayName" name="displayName" required maxLength={256} />
              </div>
              <div>
                <Label htmlFor="parentId">父级 ID</Label>
                <Input id="parentId" name="parentId" inputMode="numeric" />
              </div>
              <div>
                <Label htmlFor="metadata">元数据 JSON</Label>
                <Input id="metadata" name="metadata" placeholder='{"grade":"G7"}' />
              </div>
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
