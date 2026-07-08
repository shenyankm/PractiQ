'use client';

import { useId, useState } from 'react';
import { Play } from 'lucide-react';
import {
  Button,
  Description,
  FieldGroup,
  Input,
  Label,
  Select,
  ListBox,
  RadioGroup,
  Radio,
  Checkbox
} from '@heroui/react';


type PracticeMode = 'all' | 'wrong' | 'by_type' | 'exam';

type PracticeSetupFormProps = {
  action: (formData: FormData) => void | Promise<void>;
  activeCount: number;
  typeCounts: Record<string, number>;
  wrongCount: number;
};

export function PracticeSetupForm({
  action,
  activeCount,
  typeCounts,
  wrongCount
}: PracticeSetupFormProps) {
  const formId = useId();
  const [mode, setMode] = useState<PracticeMode>('all');
  const typeDisabled = mode !== 'by_type';
  const allQuestionsDisabled = mode !== 'all';
  const questionCountMax = Math.max(activeCount, 1);

  return (
    <form action={action} className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <div>
          <input type="hidden" name="mode" value={mode} />
          <RadioGroup name="mode" value={mode} onChange={(value) => setMode(value as PracticeMode)}>
            <Label>模式</Label>
            {practiceModeOptions.map((option) => (
              <Radio key={option.value} value={option.value}>
                <Radio.Content>
                  <Radio.Control><Radio.Indicator /></Radio.Control>
                  <Label>{option.ariaLabel}</Label>
                </Radio.Content>
              </Radio>
            ))}
          </RadioGroup>
          <Description>{modeDescriptions[mode]}</Description>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div data-disabled={allQuestionsDisabled}>
            <Checkbox name="allQuestions" defaultSelected isDisabled={allQuestionsDisabled}>
              <Checkbox.Content>
                <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                <Label>使用全部题目</Label>
              </Checkbox.Content>
            </Checkbox>
            <Description>仅全量练习启用。取消后按下方题目数量抽题。</Description>
          </div>

          <div>
            <Label htmlFor={`${formId}-questionCount`}>题目数量</Label>
            <Input
              id={`${formId}-questionCount`}
              name="questionCount"
              type="number"
              min={1}
              max={questionCountMax}
              defaultValue={activeCount || 10}
            />
            <Description>错题、按题型和模考都会按此数量抽题。</Description>
          </div>
        </div>

        <div data-disabled={typeDisabled}>
          <Select name="questionTypeId" defaultSelectedKey="all" isDisabled={typeDisabled}>
            <Label>题型</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="all">全部题型</ListBox.Item>
                {Object.entries(typeCounts).map(([typeId, count]) => (
                  <ListBox.Item key={typeId} id={typeId}>{typeId} ({count})</ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <Description>仅按题型练习启用。</Description>
        </div>
      </FieldGroup>

      <input type="hidden" name="sessionType" value="practice" />
      <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">错题集：{wrongCount} 题</div>
      <Button type="submit" isDisabled={activeCount === 0}>
        <Play className="size-4" />
        开始
      </Button>
    </form>
  );
}


const modeDescriptions: Record<PracticeMode, string> = {
  all: '从当前题库全部可练习题目中抽取。',
  wrong: '仅复习你答错过的题目。',
  by_type: '按指定题型抽题，适合集中训练薄弱类型。',
  exam: '使用模考会话记录结果，适合阶段自测。'
};

const practiceModeOptions: Array<{ value: PracticeMode; label: string; ariaLabel: string }> = [
  { value: 'all', label: '全量', ariaLabel: '全量练习' },
  { value: 'wrong', label: '错题', ariaLabel: '错题集练习' },
  { value: 'by_type', label: '按题型', ariaLabel: '按题型练习' },
  { value: 'exam', label: '模考', ariaLabel: '自测模考' }
];
