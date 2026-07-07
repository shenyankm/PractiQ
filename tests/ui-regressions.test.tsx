// @vitest-environment jsdom

import React from 'react';
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

    const radios = [
      screen.getByRole('radio', { name: '全量练习' }),
      screen.getByRole('radio', { name: '错题集练习' }),
      screen.getByRole('radio', { name: '按题型练习' }),
      screen.getByRole('radio', { name: '自测模考' })
    ] as HTMLInputElement[];

    expect(new Set(radios.map((radio) => radio.getAttribute('name')))).toEqual(new Set(['mode']));
    expect(source).toMatch(/<label[\s\S]*className="[^"]*(?:peer-focus-visible|has-\[:focus-visible\])[^"]*"/);
  });

  it('gives each new-question answer-mode radio the same name and a focus-visible label treatment', () => {
    const source = readFileSync('app/(openwook)/banks/[bankId]/manage/new-question-form.tsx', 'utf8');

    render(<NewQuestionForm action={vi.fn()} types={questionTypes} />);

    const radios = [
      screen.getByRole('radio', { name: '选择题' }),
      screen.getByRole('radio', { name: '判断题' }),
      screen.getByRole('radio', { name: '填空题' }),
      screen.getByRole('radio', { name: '简答题' })
    ] as HTMLInputElement[];

    expect(new Set(radios.map((radio) => radio.getAttribute('name')))).toEqual(new Set(['answerMode']));
    expect(source).toMatch(/<label[\s\S]*className="[^"]*(?:peer-focus-visible|has-\[:focus-visible\])[^"]*"/);
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
