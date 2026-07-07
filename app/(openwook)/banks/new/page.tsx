import { listSubjects } from '@/lib/openwook/services';
import { createBankAction } from '../actions';
import { Button } from '@heroui/react/button';
import { Card, CardContent, CardHeader, CardTitle } from '@heroui/react/card';
import { Input } from '@heroui/react/input';
import { Label } from '@heroui/react/label';
import { TextArea } from '@heroui/react/textarea';

export default async function NewBankPage() {
  const subjects = await listSubjects();

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">新建题库</h1>
        <p className="text-sm text-muted-foreground">题库学科会约束后续题目和题组。</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>题库信息</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createBankAction} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">名称</Label>
              <Input id="name" name="name" required maxLength={100} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="description">描述</Label>
              <TextArea id="description" name="description" rows={4} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="subject">学科</Label>
              <select id="subject" className="w-full" name="subject" defaultValue={subjects[0]?.subject_id}>
{subjects.map((subject) => (
                      <option key={subject.subject_id} value={subject.subject_id}>
                        {subject.display_name}
                      </option>
                    ))}
</select>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="isPublic"
                name="isPublic"
                type="checkbox"
                className="size-4 rounded border border-border"
              />
              <Label htmlFor="isPublic" className="font-normal">
              公开题库
              </Label>
            </div>
            <Button type="submit">创建题库</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
