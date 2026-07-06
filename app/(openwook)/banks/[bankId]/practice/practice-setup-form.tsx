'use client';

import { useId, useState } from 'react';
import { Play } from 'lucide-react';
import { Button, Description, FieldGroup, Input, Label } from '@heroui/react';


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
          <Label id={`${formId}-mode-label`}>模式</Label>
          <div
            role="radiogroup"
            aria-labelledby={`${formId}-mode-label`}
            className="grid w-full grid-cols-2 gap-2 md:grid-cols-4"
          >
            {practiceModeOptions.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center justify-center rounded-md border border-border/70 px-3 py-2 text-sm data-[checked=true]:bg-foreground/10 data-[checked=true]:text-foreground"
                data-checked={mode === option.value}
              >
                <input
                  type="radio"
                  className="sr-only"
                  aria-label={option.ariaLabel}
                  checked={mode === option.value}
                  onChange={() => setMode(option.value)}
                />
                {option.label}
              </label>
            ))}
          </div>
          <input type="hidden" name="mode" value={mode} />
          <Description>{modeDescriptions[mode]}</Description>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div data-disabled={allQuestionsDisabled}>
            <div className="flex items-center gap-3 rounded-md border px-3 py-2">
              <input
                id={`${formId}-allQuestions`}
                name="allQuestions"
                type="checkbox"
                className="size-4 rounded border border-border"
                defaultChecked
                disabled={allQuestionsDisabled}
              />
              <Label htmlFor={`${formId}-allQuestions`} className="font-normal">
                使用全部题目
              </Label>
            </div>
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
          <Label htmlFor={`${formId}-questionTypeId`}>题型</Label>
          <select id={`${formId}-questionTypeId`} className="w-full" name="questionTypeId" defaultValue="all" disabled={typeDisabled}>
<option value="all">全部题型</option>
                {Object.entries(typeCounts).map(([typeId, count]) => (
                  <option key={typeId} value={typeId}>{typeId} ({count})</option>
                ))}
</select>
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
