// @vitest-environment jsdom

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PracticeSetupForm } from '@/app/(openwook)/banks/[bankId]/practice/page';
import { NewQuestionForm } from '@/app/(openwook)/banks/[bankId]/manage/new-question-form';
import { AnswerForm } from '@/app/(openwook)/practice/[sessionId]/answer-form';
import type { QuestionType } from '@/lib/openwook/types';

const questionTypes: QuestionType[] = [
  {
    type_id: 'math_choice',
    subject_id: 'math',
    display_name: '数学选择题',
    scope: 'question',
    default_answer_mode: 'choice'
  }
];

describe('UI regression guardrails', () => {
  it('keeps bank detail action links free of stray spaces in path and query hrefs', () => {
    const source = readFileSync('app/(openwook)/banks/[bankId]/page.tsx', 'utf8');

    expect(source).toContain('href={`/banks/${id}/practice`}');
    expect(source).toContain('href={`/banks/${id}/manage`}');
    expect(source).toContain('href={`/imports?bankId=${id}`}');
    expect(source).not.toContain('href={`/banks/${id} /practice`}');
    expect(source).not.toContain('href={`/banks/${id} /manage`}');
    expect(source).not.toContain('href={`/imports?bankId=${id} `}');
  });

  it('wraps disabled answer controls in a disabled fieldset instead of clone-based recursion', () => {
    const source = readFileSync('app/(openwook)/practice/[sessionId]/answer-form.tsx', 'utf8');
    const { container } = render(
      <AnswerForm action={vi.fn()} disabled>
        <div>
          <input aria-label="选项 A" name="selected" />
          <textarea aria-label="答案" name="value" />
        </div>
      </AnswerForm>
    );

    expect(source).toContain('<fieldset');
    expect(source).not.toContain('React.cloneElement');
    expect(container.querySelector('fieldset[disabled]')).toBeTruthy();
    expect(container.querySelector('fieldset[disabled] input[name="selected"]')).toBeTruthy();
    expect(container.querySelector('fieldset[disabled] textarea[name="value"]')).toBeTruthy();
    expect(container.querySelector('fieldset[disabled] button[type="submit"]')).toBeTruthy();
  });

  it('gives each practice mode radio the same name and a focus-visible label treatment', () => {
    const source = readFileSync('app/(openwook)/banks/[bankId]/practice/practice-setup-form.tsx', 'utf8');

    render(
      <PracticeSetupForm
        action={vi.fn()}
        activeCount={12}
        wrongCount={3}
        typeCounts={{ 选择题: 6, 判断题: 6 }}
      />
    );

    expect(screen.getByRole('radiogroup', { name: '模式' })).toBeTruthy();
    expect(screen.getByText('全量练习')).toBeTruthy();
    expect(screen.getByText('错题集练习')).toBeTruthy();
    expect(screen.getByText('按题型练习')).toBeTruthy();
    expect(screen.getByText('自测模考')).toBeTruthy();
    expect(source).toContain('<RadioGroup name="mode"');
  });

  it('gives each new-question answer-mode radio the same name and a focus-visible label treatment', () => {
    const source = readFileSync('app/(openwook)/banks/[bankId]/manage/new-question-form.tsx', 'utf8');

    render(<NewQuestionForm action={vi.fn()} types={questionTypes} />);

    expect(screen.getByRole('radiogroup', { name: '答题模式' })).toBeTruthy();
    expect(screen.getByText('选择题')).toBeTruthy();
    expect(screen.getByText('判断题')).toBeTruthy();
    expect(screen.getByText('填空题')).toBeTruthy();
    expect(screen.getByText('简答题')).toBeTruthy();
    expect(source).toContain('<RadioGroup name="answerMode"');
  });

  it('moves settings profile and password forms behind action-state feedback surfaces', () => {
    const page = readFileSync('app/(openwook)/settings/page.tsx', 'utf8');
    const settingsSources = tsxFiles('app/(openwook)/settings').map((file) => readFileSync(file, 'utf8'));

    expect(page).not.toContain('<form action={updateProfileAction}>');
    expect(page).not.toContain('<form action={updatePasswordAction}>');
    expect(settingsSources.some((source) => source.includes('useActionState'))).toBe(true);
    expect(settingsSources.some((source) => /aria-live=|role="alert"/.test(source))).toBe(true);
  });
});

function tsxFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      const stats = statSync(path);

      if (stats.isDirectory()) return tsxFiles(path);
      return path.endsWith('.tsx') ? [path] : [];
    });
}
