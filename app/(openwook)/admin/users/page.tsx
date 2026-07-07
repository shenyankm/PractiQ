import { Search, Shield, UserRound, UsersRound } from 'lucide-react';
import Link from 'next/link';
import { listAdminUsers } from '@/lib/openwook/services';
import { requireAdminPage } from '../admin-auth';
import { AdminNav } from '../admin-nav';
import { setUserStatusAction, updateUserAccessAction } from '../actions';
import { AlertDialog } from '@heroui/react/alert-dialog';
import { Badge } from '@heroui/react/badge';
import { Button } from '@heroui/react/button';
import { Card, CardContent, CardHeader, CardTitle } from '@heroui/react/card';
import { EmptyState } from '@heroui/react/empty-state';
import { Input } from '@heroui/react/input';
import { Label } from '@heroui/react/label';

export default async function AdminUsersPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireAdminPage();
  const params = normalizeParams(await searchParams);
  const users = await listAdminUsers(user, params);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">用户管理</h1>
          <p className="text-sm text-muted-foreground">查看用户状态、角色、会员和使用情况。</p>
        </div>
        <Link href="/admin" className="button button--outline">
  返回后台
</Link>
      </div>

      <AdminNav />

      <Card>
        <CardContent className="p-4">
          <form className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_160px_auto_auto] md:items-end">
            <div className="gap-2">
              <Label htmlFor="admin-user-search" className="sr-only">搜索用户</Label>
              <div className="relative">
                <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                <Input id="admin-user-search" name="q" placeholder="搜索用户名或邮箱" defaultValue={params.get('q') ?? ''} className="pl-9" />
              </div>
            </div>
            <div className="gap-2">
              <Label htmlFor="admin-user-status" className="sr-only">状态</Label>
              <select id="admin-user-status" className="w-full" name="status" defaultValue={params.get('status') ?? 'all'}>
<option value="all">全部状态</option>
                    <option value="active">启用</option>
                    <option value="inactive">停用</option>
</select>
            </div>
            <div className="gap-2">
              <Label htmlFor="admin-user-role" className="sr-only">角色</Label>
              <select id="admin-user-role" className="w-full" name="role" defaultValue={params.get('role') ?? 'all'}>
<option value="all">全部角色</option>
                    <option value="admin">管理员</option>
                    <option value="user">用户</option>
</select>
            </div>
            <Button type="submit" variant="outline">筛选</Button>
            <Link href="/admin/users" className="button button--ghost">
  重置
</Link>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><UsersRound className="size-4" />用户列表</CardTitle>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <EmptyState>
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
                  <UsersRound />
                </div>
                <h3 className="text-base font-semibold">没有匹配的用户</h3>
                <p className="text-sm text-muted-foreground">调整搜索、状态或角色筛选条件后再试。</p>
              </div>
            </EmptyState>
          ) : null}
          {users.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/70 text-left">
                    <th className="px-3 py-2 font-medium">用户</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">使用情况</th>
                    <th className="min-w-80 px-3 py-2 font-medium">权限</th>
                    <th className="px-3 py-2 text-right font-medium">账号</th>
                  </tr>
                </thead>
                <tbody>
                {users.map((item) => (
                  <tr key={item.id} className="border-b border-border/60">
                    <td className="min-w-56 whitespace-normal px-3 py-3">
                      <div className="flex items-center gap-2">
                        <UserRound className="size-4 text-muted-foreground" />
                        <span className="font-medium">{item.username}</span>
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">{item.email || '未绑定邮箱'}</div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="secondary" color={item.is_active ? 'success' : 'danger'}>{item.is_active ? '启用' : '停用'}</Badge>
                        <Badge variant={item.role === 'admin' ? 'primary' : 'soft'} className="gap-1">
                          {item.role === 'admin' ? <Shield className="size-3" /> : null}
                          {item.role}
                        </Badge>
                        <Badge variant="soft">{item.membership}</Badge>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      题库 {item.bank_count} · 导入 {item.import_job_count} · 练习 {item.practice_session_count}
                    </td>
                    <td className="px-3 py-3">
                      <form action={updateUserAccessAction.bind(null, item.id)} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                        <div>
                          <Label htmlFor={`role-${item.id}`} className="sr-only">角色</Label>
                          <select id={`role-${item.id}`} className="w-full" name="role" defaultValue={item.role} disabled={item.id === user.id}>
<option value="user">用户</option>
                                <option value="admin">管理员</option>
</select>
                        </div>
                        <div>
                          <Label htmlFor={`membership-${item.id}`} className="sr-only">会员</Label>
                          <select id={`membership-${item.id}`} className="w-full" name="membership" defaultValue={item.membership}>
<option value="free">free</option>
                                <option value="plus">plus</option>
</select>
                        </div>
                        <Button type="submit" size="sm" variant="outline">保存</Button>
                      </form>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <AlertDialog>
                        <Button
                          type="button"
                          size="sm"
                          variant={item.is_active ? 'outline' : 'primary'}
                          isDisabled={item.id === user.id}
                        >
                          {item.is_active ? '停用' : '启用'}
                        </Button>
                        <AlertDialog.Backdrop>
                          <AlertDialog.Container>
                            <AlertDialog.Dialog>
                              <AlertDialog.Header>
                                <AlertDialog.Heading>{item.is_active ? '确认停用用户' : '确认启用用户'}</AlertDialog.Heading>
                              </AlertDialog.Header>
                              <AlertDialog.Body>
                                <p>
                              {item.is_active
                                ? `停用 ${item.username} 后，该用户将无法继续登录和使用题库。`
                                : `启用 ${item.username} 后，该用户可以重新登录 OpenWook。`}
                                </p>
                              </AlertDialog.Body>
                              <AlertDialog.Footer>
                                <Button slot="close" variant="tertiary">取消</Button>
                                <form action={setUserStatusAction.bind(null, item.id, !item.is_active)}>
                                  <Button type="submit" className="w-full sm:w-auto">
                                    {item.is_active ? '确认停用' : '确认启用'}
                                  </Button>
                                </form>
                              </AlertDialog.Footer>
                            </AlertDialog.Dialog>
                          </AlertDialog.Container>
                        </AlertDialog.Backdrop>
                      </AlertDialog>
                    </td>
                  </tr>
                ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function normalizeParams(params: Record<string, string | string[] | undefined>) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value) searchParams.set(key, value);
  }
  return searchParams;
}
