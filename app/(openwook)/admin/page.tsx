import { BookOpen, Database, FileWarning, Shield, Tags, UsersRound } from 'lucide-react';
import Link from 'next/link';
import { getAdminOverview } from '@/lib/openwook/services';
import { AdminNav } from './admin-nav';
import { requireAdminPage } from './admin-auth';
import { Badge } from '@heroui/react/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@heroui/react/card';

export default async function AdminPage() {
  const user = await requireAdminPage();
  const overview = await getAdminOverview(user);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">后台管理</h1>
          <p className="text-sm text-muted-foreground">管理用户、知识点和平台级基础数据。</p>
        </div>
        <Badge variant="secondary" className="gap-1">
          <Shield className="size-3" />
          admin
        </Badge>
      </div>

      <AdminNav />

      <div className="grid gap-4 md:grid-cols-3">
        <Metric title="用户" value={`${overview.active_users}/${overview.total_users}`} icon={UsersRound} />
        <Metric title="题库" value={overview.total_banks} icon={Database} />
        <Metric title="题目" value={overview.total_questions} icon={BookOpen} />
        <Metric title="付费用户" value={overview.plus_users} icon={Shield} />
        <Metric title="导入任务" value={overview.import_jobs} icon={FileWarning} />
        <Metric title="知识点" value={overview.knowledge_points} icon={Tags} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><UsersRound className="size-4" />用户管理</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              查看用户角色、会员、题库和导入使用情况，启用或停用账号。
            </p>
            <Link href="/admin/users" className="button button--primary w-fit">
  进入用户管理
</Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Tags className="size-4" />知识点管理</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              维护学科知识点编码、名称、父级关系和结构化元数据。
            </p>
            <Link href="/admin/knowledge-points" className="button button--primary w-fit">
  进入知识点管理
</Link>
          </CardContent>
        </Card>
      </div>

      {overview.open_review_items > 0 ? (
        <Card>
          <CardContent className="flex items-center justify-between gap-4 p-4">
            <div className="flex items-center gap-2 text-sm">
              <FileWarning className="size-4 text-foreground" />
              当前有 {overview.open_review_items} 个导入复核项待处理。
            </div>
            <Link href="/imports" className="button button--outline button--sm">
  查看导入任务
</Link>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Metric({ title, value, icon: Icon }: { title: string; value: string | number; icon: React.ElementType }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <div className="text-sm text-muted-foreground">{title}</div>
          <div className="mt-1 text-2xl font-semibold">{value}</div>
        </div>
        <Icon className="size-5 text-muted-foreground" />
      </CardContent>
    </Card>
  );
}
