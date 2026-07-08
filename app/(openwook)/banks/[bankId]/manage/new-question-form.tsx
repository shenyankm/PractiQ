'use client';
import { Save } from 'lucide-react';
import { useId, useState } from 'react';

import type { AnswerMode, QuestionType } from '@/lib/openwook/types';
import {
  Button,
  Description,
  FieldGroup,
  Input,
  Label,
  TextArea,
  Select,
  ListBox,
  RadioGroup,
  Radio
} from '@heroui/react';

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
          <Select name="questionTypeId" defaultSelectedKey={types[0]?.type_id}>
            <Label>题型</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {types.map((type) => (
                  <ListBox.Item key={type.type_id} id={type.type_id}>
                    {type.display_name}
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          {types.length === 0 ? <Description>当前学科暂无题型配置。</Description> : null}
        </div>

        <div>
          <input type="hidden" name="answerMode" value={answerMode} />
          <RadioGroup name="answerMode" value={answerMode} onChange={(value) => setAnswerMode(value as AnswerMode)}>
            <Label>答题模式</Label>
            {answerModeOptions.map((option) => (
              <Radio key={option.value} value={option.value}>
                <Radio.Content>
                  <Radio.Control><Radio.Indicator /></Radio.Control>
                  <Label>{option.ariaLabel}</Label>
                </Radio.Content>
              </Radio>
            ))}
          </RadioGroup>
          <Description>{answerModeDescriptions[answerMode]}</Description>
        </div>

        <div>
          <Label htmlFor={`${formId}-stem`}>题干</Label>
          <TextArea id={`${formId}-stem`} name="stem" rows={5} required />
        </div>

        {answerMode === 'choice' ? (
          <ChoiceAnswerFields formId={formId} />
        ) : answerMode === 'true_false' ? (
          <TrueFalseAnswerFields />
        ) : (
          <TextAnswerFields formId={formId} answerMode={answerMode} />
        )}

        <div>
          <Label htmlFor={`${formId}-analysis`}>解析</Label>
          <TextArea id={`${formId}-analysis`} name="analysis" rows={3} />
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="sm:w-36">
            <Select name="status" defaultSelectedKey="draft">
              <Label>状态</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="draft">草稿</ListBox.Item>
                  <ListBox.Item id="active">发布</ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
          <Button type="submit">
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
        <Select name="correctOption" defaultSelectedKey="A">
          <Label>正确选项</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id="A">A</ListBox.Item>
              <ListBox.Item id="B">B</ListBox.Item>
              <ListBox.Item id="C">C</ListBox.Item>
              <ListBox.Item id="D">D</ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
    </>
  );
}

function TrueFalseAnswerFields() {
  return (
    <div>
      <Select name="answer" defaultSelectedKey="true">
        <Label>正确答案</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            <ListBox.Item id="true">正确</ListBox.Item>
            <ListBox.Item id="false">错误</ListBox.Item>
          </ListBox>
        </Select.Popover>
      </Select>
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
