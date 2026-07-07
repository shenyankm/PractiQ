// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '@heroui/react/button';

describe('HeroUI integration', () => {
  it('renders a HeroUI component', () => {
    render(<Button variant="tertiary">HeroUI ready</Button>);

    expect(screen.getByRole('button', { name: 'HeroUI ready' })).toBeTruthy();
  });
});
