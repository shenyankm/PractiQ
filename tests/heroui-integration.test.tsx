// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '@heroui/react';

describe('HeroUI integration', () => {
  it('renders a HeroUI component', () => {
    render(<Button variant="tertiary">HeroUI ready</Button>);

    const button = screen.getByRole('button', { name: 'HeroUI ready' });
    expect(button).toBeTruthy();
    expect(button.className).toContain('button');
  });
});
