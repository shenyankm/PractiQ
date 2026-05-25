'use client';

import { useId, useState } from 'react';
import { Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

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
        <Field>
          <FieldLabel id={`${formId}-mode-label`}>模式</FieldLabel>
          <ToggleGroup
            type="single"
            value={mode}
            onValueChange={(value) => {
              if (isPracticeMode(value)) setMode(value);
            }}
            className="grid w-full grid-cols-2 md:grid-cols-4"
            variant="outline"
            aria-labelledby={`${formId}-mode-label`}
          >
            <ToggleGroupItem value="all" aria-label="全量练习">全量</ToggleGroupItem>
            <ToggleGroupItem value="wrong" aria-label="错题集练习">错题</ToggleGroupItem>
            <ToggleGroupItem value="by_type" aria-label="按题型练习">按题型</ToggleGroupItem>
            <ToggleGroupItem value="exam" aria-label="自测模考">模考</ToggleGroupItem>
          </ToggleGroup>
          <input type="hidden" name="mode" value={mode} />
          <FieldDescription>{modeDescriptions[mode]}</FieldDescription>
        </Field>

        <div className="grid gap-4 md:grid-cols-2">
          <Field data-disabled={allQuestionsDisabled}>
            <div className="flex items-center gap-3 rounded-md border px-3 py-2">
              <Checkbox
                id={`${formId}-allQuestions`}
                name="allQuestions"
                defaultChecked
                disabled={allQuestionsDisabled}
              />
              <FieldLabel htmlFor={`${formId}-allQuestions`} className="font-normal">
                使用全部题目
              </FieldLabel>
            </div>
            <FieldDescription>仅全量练习启用。取消后按下方题目数量抽题。</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`${formId}-questionCount`}>题目数量</FieldLabel>
            <Input
              id={`${formId}-questionCount`}
              name="questionCount"
              type="number"
              min={1}
              max={questionCountMax}
              defaultValue={activeCount || 10}
            />
            <FieldDescription>错题、按题型和模考都会按此数量抽题。</FieldDescription>
          </Field>
        </div>

        <Field data-disabled={typeDisabled}>
          <FieldLabel htmlFor={`${formId}-questionTypeId`}>题型</FieldLabel>
          <Select name="questionTypeId" defaultValue="all" disabled={typeDisabled}>
            <SelectTrigger id={`${formId}-questionTypeId`} className="w-full">
              <SelectValue placeholder="选择题型" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部题型</SelectItem>
                {Object.entries(typeCounts).map(([typeId, count]) => (
                  <SelectItem key={typeId} value={typeId}>{typeId} ({count})</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>仅按题型练习启用。</FieldDescription>
        </Field>
      </FieldGroup>

      <input type="hidden" name="sessionType" value="practice" />
      <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">错题集：{wrongCount} 题</div>
      <Button type="submit" disabled={activeCount === 0}>
        <Play className="size-4" />
        开始
      </Button>
    </form>
  );
}

function isPracticeMode(value: string): value is PracticeMode {
  return value === 'all' || value === 'wrong' || value === 'by_type' || value === 'exam';
}

const modeDescriptions: Record<PracticeMode, string> = {
  all: '从当前题库全部可练习题目中抽取。',
  wrong: '仅复习你答错过的题目。',
  by_type: '按指定题型抽题，适合集中训练薄弱类型。',
  exam: '使用模考会话记录结果，适合阶段自测。'
};
