'use client';
import { Save } from 'lucide-react';
import { useId, useState } from 'react';

import type { AnswerMode, QuestionType } from '@/lib/openwook/types';
import { Button } from '@heroui/react/button';
import { Description } from '@heroui/react/description';
import { FieldGroup } from '@heroui/react/fieldset';
import { Input } from '@heroui/react/input';
import { Label } from '@heroui/react/label';
import { TextArea } from '@heroui/react/textarea';

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
        <div>
          <Label htmlFor={`${formId}-questionTypeId`}>题型</Label>
          <select id={`${formId}-questionTypeId`} className="w-full" name="questionTypeId" defaultValue={types[0]?.type_id}>
{types.map((type) => (
                  <option key={type.type_id} value={type.type_id}>
                    {type.display_name}
                  </option>
                ))}
</select>
          {types.length === 0 ? <Description>当前学科暂无题型配置。</Description> : null}
        </div>

        <div>
          <Label id={`${formId}-answerModeLabel`}>答题模式</Label>
          <input type="hidden" name="answerMode" value={answerMode} />
          <div
            role="radiogroup"
            aria-labelledby={`${formId}-answerModeLabel`}
            className="grid w-full grid-cols-2 gap-2"
          >
            {answerModeOptions.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center justify-center rounded-md border border-border/70 px-3 py-2 text-sm data-[checked=true]:bg-foreground/10 data-[checked=true]:text-foreground has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/35"
                data-checked={answerMode === option.value}
              >
                <input
                  type="radio"
                  name="answerMode"
                  value={option.value}
                  className="sr-only"
                  aria-label={option.ariaLabel}
                  checked={answerMode === option.value}
                  onChange={() => setAnswerMode(option.value)}
                />
                {option.label}
              </label>
            ))}
          </div>
          <Description>{answerModeDescriptions[answerMode]}</Description>
        </div>

        <div>
          <Label htmlFor={`${formId}-stem`}>题干</Label>
          <TextArea id={`${formId}-stem`} name="stem" rows={5} required />
        </div>

        {answerMode === 'choice' ? (
          <ChoiceAnswerFields formId={formId} />
        ) : answerMode === 'true_false' ? (
          <TrueFalseAnswerFields formId={formId} />
        ) : (
          <TextAnswerFields formId={formId} answerMode={answerMode} />
        )}

        <div>
          <Label htmlFor={`${formId}-analysis`}>解析</Label>
          <TextArea id={`${formId}-analysis`} name="analysis" rows={3} />
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="sm:w-36">
            <Label htmlFor={`${formId}-status`}>状态</Label>
            <select id={`${formId}-status`} className="w-full" name="status" defaultValue="draft">
<option value="draft">草稿</option>
                  <option value="active">发布</option>
</select>
          </div>
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
          <div key={label}>
            <Label htmlFor={`${formId}-option${label}`}>选项 {label}</Label>
            <Input id={`${formId}-option${label}`} name={`option${label}`} required={label === 'A' || label === 'B'} />
          </div>
        ))}
      </div>
      <div>
        <Label htmlFor={`${formId}-correctOption`}>正确选项</Label>
        <select id={`${formId}-correctOption`} className="w-full" name="correctOption" defaultValue="A">
<option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
              <option value="D">D</option>
</select>
      </div>
    </>
  );
}

function TrueFalseAnswerFields({ formId }: { formId: string }) {
  return (
    <div>
      <Label htmlFor={`${formId}-answer`}>正确答案</Label>
      <select id={`${formId}-answer`} className="w-full" name="answer" defaultValue="true">
<option value="true">正确</option>
            <option value="false">错误</option>
</select>
    </div>
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
    <div>
      <Label htmlFor={`${formId}-answer`}>{answerMode === 'fill_blank' ? '标准答案' : '参考答案'}</Label>
      <TextArea
        id={`${formId}-answer`}
        name="answer"
        rows={answerMode === 'fill_blank' ? 2 : 4}
        placeholder={answerMode === 'fill_blank' ? '填写可判定的标准答案' : '填写评分参考或示例答案'}
      />
    </div>
  );
}


const answerModeDescriptions: Record<AnswerMode, string> = {
  choice: '展示选项和正确选项字段。',
  true_false: '只需选择正确或错误。',
  fill_blank: '填写可自动比对的标准答案。',
  short_answer: '填写人工复核或自评用的参考答案。'
};

const answerModeOptions: Array<{ value: AnswerMode; label: string; ariaLabel: string }> = [
  { value: 'choice', label: '选择', ariaLabel: '选择题' },
  { value: 'true_false', label: '判断', ariaLabel: '判断题' },
  { value: 'fill_blank', label: '填空', ariaLabel: '填空题' },
  { value: 'short_answer', label: '简答', ariaLabel: '简答题' }
];
