import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { listSubjects } from '@/lib/openwook/services';
import { createBankAction } from '../actions';

export default async function NewBankPage() {
  const subjects = await listSubjects();

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">新建题库</h1>
        <p className="text-sm text-slate-500">题库学科会约束后续题目和题组。</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>题库信息</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createBankAction} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">名称</Label>
              <Input id="name" name="name" required maxLength={100} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">描述</Label>
              <textarea id="description" name="description" rows={4} className="w-full rounded-md border bg-white px-3 py-2 text-sm" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="subject">学科</Label>
              <select id="subject" name="subject" className="h-9 w-full rounded-md border bg-white px-3 text-sm">
                {subjects.map((subject) => (
                  <option key={subject.subject_id} value={subject.subject_id}>{subject.display_name}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isPublic" />
              公开题库
            </label>
            <Button type="submit">创建题库</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
