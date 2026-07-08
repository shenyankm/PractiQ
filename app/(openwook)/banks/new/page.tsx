import { listSubjects } from '@/lib/openwook/services';
import { createBankAction } from '../actions';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  TextArea,
  Select,
  ListBox,
  Checkbox
} from '@heroui/react';

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
              <Select name="subject" defaultSelectedKey={subjects[0]?.subject_id}>
                <Label>学科</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {subjects.map((subject) => (
                      <ListBox.Item key={subject.subject_id} id={subject.subject_id}>
                        {subject.display_name}
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
                        <Checkbox name="isPublic">
              <Checkbox.Content>
                <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                <Label>公开题库</Label>
              </Checkbox.Content>
            </Checkbox>
            <Button type="submit">创建题库</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
