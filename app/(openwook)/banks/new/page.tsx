import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { listSubjects } from '@/lib/openwook/services';
import { createBankAction } from '../actions';

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
              <Textarea id="description" name="description" rows={4} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="subject">学科</Label>
              <Select name="subject" defaultValue={subjects[0]?.subject_id}>
                <SelectTrigger id="subject" className="w-full">
                  <SelectValue placeholder="选择学科" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {subjects.map((subject) => (
                      <SelectItem key={subject.subject_id} value={subject.subject_id}>
                        {subject.display_name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="isPublic" name="isPublic" />
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
