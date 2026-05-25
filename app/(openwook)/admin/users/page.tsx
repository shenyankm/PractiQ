import Link from 'next/link';
import { Search, Shield, UserRound, UsersRound } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { listAdminUsers } from '@/lib/openwook/services';
import { requireAdminPage } from '../admin-auth';
import { AdminNav } from '../admin-nav';
import { setUserStatusAction, updateUserAccessAction } from '../actions';

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
        <Button asChild variant="outline">
          <Link href="/admin">返回后台</Link>
        </Button>
      </div>

      <AdminNav />

      <Card>
        <CardContent className="p-4">
          <form className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_160px_auto_auto] md:items-end">
            <Field className="gap-2">
              <FieldLabel htmlFor="admin-user-search" className="sr-only">搜索用户</FieldLabel>
              <div className="relative">
                <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                <Input id="admin-user-search" name="q" placeholder="搜索用户名或邮箱" defaultValue={params.get('q') ?? ''} className="pl-9" />
              </div>
            </Field>
            <Field className="gap-2">
              <FieldLabel htmlFor="admin-user-status" className="sr-only">状态</FieldLabel>
              <Select name="status" defaultValue={params.get('status') ?? 'all'}>
                <SelectTrigger id="admin-user-status" className="w-full">
                  <SelectValue placeholder="状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">全部状态</SelectItem>
                    <SelectItem value="active">启用</SelectItem>
                    <SelectItem value="inactive">停用</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field className="gap-2">
              <FieldLabel htmlFor="admin-user-role" className="sr-only">角色</FieldLabel>
              <Select name="role" defaultValue={params.get('role') ?? 'all'}>
                <SelectTrigger id="admin-user-role" className="w-full">
                  <SelectValue placeholder="角色" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">全部角色</SelectItem>
                    <SelectItem value="admin">管理员</SelectItem>
                    <SelectItem value="user">用户</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Button type="submit" variant="outline">筛选</Button>
            <Button asChild variant="ghost">
              <Link href="/admin/users">重置</Link>
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><UsersRound className="size-4" />用户列表</CardTitle>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UsersRound />
                </EmptyMedia>
                <EmptyTitle>没有匹配的用户</EmptyTitle>
                <EmptyDescription>调整搜索、状态或角色筛选条件后再试。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          {users.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>使用情况</TableHead>
                  <TableHead className="min-w-80">权限</TableHead>
                  <TableHead className="text-right">账号</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="min-w-56 whitespace-normal">
                      <div className="flex items-center gap-2">
                        <UserRound className="size-4 text-muted-foreground" />
                        <span className="font-medium">{item.username}</span>
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">{item.email || '未绑定邮箱'}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant={item.is_active ? 'secondary' : 'destructive'}>{item.is_active ? '启用' : '停用'}</Badge>
                        <Badge variant={item.role === 'admin' ? 'default' : 'outline'} className="gap-1">
                          {item.role === 'admin' ? <Shield className="size-3" /> : null}
                          {item.role}
                        </Badge>
                        <Badge variant="outline">{item.membership}</Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      题库 {item.bank_count} · 导入 {item.import_job_count} · 练习 {item.practice_session_count}
                    </TableCell>
                    <TableCell>
                      <form action={updateUserAccessAction.bind(null, item.id)} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                        <Field>
                          <FieldLabel htmlFor={`role-${item.id}`} className="sr-only">角色</FieldLabel>
                          <Select name="role" defaultValue={item.role} disabled={item.id === user.id}>
                            <SelectTrigger id={`role-${item.id}`} className="w-full">
                              <SelectValue placeholder="角色" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectItem value="user">用户</SelectItem>
                                <SelectItem value="admin">管理员</SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={`membership-${item.id}`} className="sr-only">会员</FieldLabel>
                          <Select name="membership" defaultValue={item.membership}>
                            <SelectTrigger id={`membership-${item.id}`} className="w-full">
                              <SelectValue placeholder="会员" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectItem value="free">free</SelectItem>
                                <SelectItem value="plus">plus</SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                        <Button type="submit" size="sm" variant="outline">保存</Button>
                      </form>
                    </TableCell>
                    <TableCell className="text-right">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            size="sm"
                            variant={item.is_active ? 'outline' : 'default'}
                            disabled={item.id === user.id}
                          >
                            {item.is_active ? '停用' : '启用'}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{item.is_active ? '确认停用用户' : '确认启用用户'}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {item.is_active
                                ? `停用 ${item.username} 后，该用户将无法继续登录和使用题库。`
                                : `启用 ${item.username} 后，该用户可以重新登录 OpenWook。`}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <form action={setUserStatusAction.bind(null, item.id, !item.is_active)}>
                              <AlertDialogAction type="submit" className="w-full sm:w-auto">
                                {item.is_active ? '确认停用' : '确认启用'}
                              </AlertDialogAction>
                            </form>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
