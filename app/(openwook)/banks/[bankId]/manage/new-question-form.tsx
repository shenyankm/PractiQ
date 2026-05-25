'use client';

import { useId, useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { AnswerMode, QuestionType } from '@/lib/openwook/types';

type NewQuestionFormProps = {
  action: (formData: FormData) => void | Promise<void>;
  types: QuestionType[];
};

export function NewQuestionForm({ action, types }: NewQuestionFormProps) {
  const formId = useId();
  const [answerMode, setAnswerMode] = useState<AnswerMode>('choice');

  return (
    <form action={action} className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor={`${formId}-questionTypeId`}>题型</FieldLabel>
          <Select name="questionTypeId" defaultValue={types[0]?.type_id}>
            <SelectTrigger id={`${formId}-questionTypeId`} className="w-full">
              <SelectValue placeholder="选择题型" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {types.map((type) => (
                  <SelectItem key={type.type_id} value={type.type_id}>
                    {type.display_name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {types.length === 0 ? <FieldDescription>当前学科暂无题型配置。</FieldDescription> : null}
        </Field>

        <Field>
          <FieldLabel id={`${formId}-answerModeLabel`}>答题模式</FieldLabel>
          <ToggleGroup
            type="single"
            value={answerMode}
            onValueChange={(value) => {
              if (isAnswerMode(value)) setAnswerMode(value);
            }}
            className="grid w-full grid-cols-2"
            variant="outline"
            aria-labelledby={`${formId}-answerModeLabel`}
          >
            <ToggleGroupItem value="choice" aria-label="选择题">选择</ToggleGroupItem>
            <ToggleGroupItem value="true_false" aria-label="判断题">判断</ToggleGroupItem>
            <ToggleGroupItem value="fill_blank" aria-label="填空题">填空</ToggleGroupItem>
            <ToggleGroupItem value="short_answer" aria-label="简答题">简答</ToggleGroupItem>
          </ToggleGroup>
          <input type="hidden" name="answerMode" value={answerMode} />
          <FieldDescription>{answerModeDescriptions[answerMode]}</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor={`${formId}-stem`}>题干</FieldLabel>
          <Textarea id={`${formId}-stem`} name="stem" rows={5} required />
        </Field>

        {answerMode === 'choice' ? (
          <ChoiceAnswerFields formId={formId} />
        ) : answerMode === 'true_false' ? (
          <TrueFalseAnswerFields formId={formId} />
        ) : (
          <TextAnswerFields formId={formId} answerMode={answerMode} />
        )}

        <Field>
          <FieldLabel htmlFor={`${formId}-analysis`}>解析</FieldLabel>
          <Textarea id={`${formId}-analysis`} name="analysis" rows={3} />
        </Field>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field className="sm:w-36">
            <FieldLabel htmlFor={`${formId}-status`}>状态</FieldLabel>
            <Select name="status" defaultValue="draft">
              <SelectTrigger id={`${formId}-status`} className="w-full">
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="draft">草稿</SelectItem>
                  <SelectItem value="active">发布</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Button type="submit" className="sm:mb-0.5">
            <Save className="size-4" />
            保存题目
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

function ChoiceAnswerFields({ formId }: { formId: string }) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        {['A', 'B', 'C', 'D'].map((label) => (
          <Field key={label}>
            <FieldLabel htmlFor={`${formId}-option${label}`}>选项 {label}</FieldLabel>
            <Input id={`${formId}-option${label}`} name={`option${label}`} required={label === 'A' || label === 'B'} />
          </Field>
        ))}
      </div>
      <Field>
        <FieldLabel htmlFor={`${formId}-correctOption`}>正确选项</FieldLabel>
        <Select name="correctOption" defaultValue="A">
          <SelectTrigger id={`${formId}-correctOption`} className="w-full">
            <SelectValue placeholder="选择正确选项" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="A">A</SelectItem>
              <SelectItem value="B">B</SelectItem>
              <SelectItem value="C">C</SelectItem>
              <SelectItem value="D">D</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </>
  );
}

function TrueFalseAnswerFields({ formId }: { formId: string }) {
  return (
    <Field>
      <FieldLabel htmlFor={`${formId}-answer`}>正确答案</FieldLabel>
      <Select name="answer" defaultValue="true">
        <SelectTrigger id={`${formId}-answer`} className="w-full">
          <SelectValue placeholder="选择正确答案" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="true">正确</SelectItem>
            <SelectItem value="false">错误</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function TextAnswerFields({
  formId,
  answerMode
}: {
  formId: string;
  answerMode: Exclude<AnswerMode, 'choice' | 'true_false'>;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={`${formId}-answer`}>{answerMode === 'fill_blank' ? '标准答案' : '参考答案'}</FieldLabel>
      <Textarea
        id={`${formId}-answer`}
        name="answer"
        rows={answerMode === 'fill_blank' ? 2 : 4}
        placeholder={answerMode === 'fill_blank' ? '填写可判定的标准答案' : '填写评分参考或示例答案'}
      />
    </Field>
  );
}

function isAnswerMode(value: string): value is AnswerMode {
  return value === 'choice' || value === 'true_false' || value === 'fill_blank' || value === 'short_answer';
}

const answerModeDescriptions: Record<AnswerMode, string> = {
  choice: '展示选项和正确选项字段。',
  true_false: '只需选择正确或错误。',
  fill_blank: '填写可自动比对的标准答案。',
  short_answer: '填写人工复核或自评用的参考答案。'
};
