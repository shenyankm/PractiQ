// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PracticeSetupForm } from '@/app/(openwook)/banks/[bankId]/practice/page';
import { NewQuestionForm } from '@/app/(openwook)/banks/[bankId]/manage/new-question-form';
import { AnswerForm } from '@/app/(openwook)/practice/[sessionId]/answer-form';
import type { QuestionType } from '@/lib/openwook/types';

describe('PracticeSetupForm', () => {
  it('renders all expected practice modes and type controls', () => {
    const { container } = render(
      <PracticeSetupForm
        action={vi.fn()}
        activeCount={12}
        wrongCount={3}
        typeCounts={{ math_calculation: 8, math_geometry: 4 }}
      />
    );

    expect(screen.getByRole('radio', { name: '全量练习' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '错题集练习' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '按题型练习' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '自测模考' })).toBeTruthy();
    expect(container.querySelector('input[name="mode"]')).toHaveProperty('value', 'all');
    expect(screen.getByText('仅按题型练习启用。')).toBeTruthy();
    expect(screen.getByText('错题集：3 题')).toBeTruthy();
    expect((screen.getByRole('button', { name: /开始/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the submitted practice mode in sync with the segmented control', () => {
    const { container } = render(
      <PracticeSetupForm
        action={vi.fn()}
        activeCount={12}
        wrongCount={3}
        typeCounts={{ math_calculation: 8, math_geometry: 4 }}
      />
    );

    fireEvent.click(screen.getByRole('radio', { name: '按题型练习' }));

    expect(container.querySelector('input[name="mode"]')).toHaveProperty('value', 'by_type');
    expect(screen.getByRole('combobox', { name: '题型' }).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('disables start when no active questions exist', () => {
    render(
      <PracticeSetupForm
        action={vi.fn()}
        activeCount={0}
        wrongCount={0}
        typeCounts={{}}
      />
    );

    expect((screen.getByRole('button', { name: /开始/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('AnswerForm', () => {
  it('disables nested answer controls after a question has been submitted', () => {
    render(
      <AnswerForm action={vi.fn()} disabled>
        <input aria-label="选项 A" name="selected" />
        <textarea aria-label="答案" name="value" />
      </AnswerForm>
    );

    expect((screen.getByLabelText('选项 A') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('答案') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '提交答案' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('NewQuestionForm', () => {
  const questionTypes: QuestionType[] = [
    {
      type_id: 'math_choice',
      subject_id: 'math',
      display_name: '数学选择题',
      scope: 'question',
      default_answer_mode: 'choice'
    }
  ];

  it('shows answer fields that match the selected answer mode', () => {
    const { container } = render(<NewQuestionForm action={vi.fn()} types={questionTypes} />);

    expect(screen.getByLabelText('选项 A')).toBeTruthy();
    expect(screen.getByRole('radio', { name: '判断题' })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: '判断题' }));

    expect(container.querySelector('input[name="answerMode"]')).toHaveProperty('value', 'true_false');
    expect(screen.queryByLabelText('选项 A')).toBeNull();
    expect(screen.getByRole('combobox', { name: '正确答案' })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: '简答题' }));

    expect(container.querySelector('input[name="answerMode"]')).toHaveProperty('value', 'short_answer');
    expect(screen.queryByRole('combobox', { name: '正确答案' })).toBeNull();
    expect(screen.getByLabelText('参考答案')).toBeTruthy();
  });
});
