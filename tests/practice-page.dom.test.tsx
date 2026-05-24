// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PracticeSetupForm } from '@/app/(openwook)/banks/[bankId]/practice/page';

describe('PracticeSetupForm', () => {
  it('renders all expected practice modes and type controls', () => {
    render(
      <PracticeSetupForm
        action={vi.fn()}
        activeCount={12}
        wrongCount={3}
        typeCounts={{ math_calculation: 8, math_geometry: 4 }}
      />
    );

    expect(screen.getByLabelText('模式').textContent).toContain('全量练习');
    expect(screen.getByLabelText('模式').textContent).toContain('错题集练习');
    expect(screen.getByLabelText('模式').textContent).toContain('按题型练习');
    expect(screen.getByLabelText('模式').textContent).toContain('自测模考');
    expect(screen.getByLabelText('题型').textContent).toContain('math_calculation (8)');
    expect(screen.getByText('错题集：3 题')).toBeTruthy();
    expect((screen.getByRole('button', { name: /开始/ }) as HTMLButtonElement).disabled).toBe(false);
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
