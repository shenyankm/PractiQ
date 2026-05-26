import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('brand color system', () => {
  it('does not leave orange Tailwind utility classes in app UI', () => {
    const offenders = tsxFiles('app')
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        return source.includes('orange') ? [file] : [];
      });

    expect(offenders).toEqual([]);
  });

  it('uses semantic neutral colors instead of page-level slate or gray utilities', () => {
    const offenders = tsxFiles('app')
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        const matches = source.matchAll(/\b(?:bg|text|border|placeholder)-(?:slate|gray)-\d{2,3}\b/g);

        return Array.from(matches, (match) => `${file}:${lineNumber(source, match.index ?? 0)}:${match[0]}`);
      });

    expect(offenders).toEqual([]);
  });

  it('uses grayscale glass theme tokens and utilities for the global visual system', () => {
    const globals = readFileSync('app/globals.css', 'utf8');

    expect(globals).toContain('--glass-bg:');
    expect(globals).toContain('--glass-border:');
    expect(globals).toContain('.ow-glass');
    expect(globals).toMatch(/--primary:\s*hsl\(0 0% 9%\)/);
    expect(globals).not.toMatch(/--primary:\s*hsl\(2(?:17|21)\./);
  });

  it('keeps page-level primary emphasis out of app routes', () => {
    const offenders = tsxFiles('app')
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        const matches = source.matchAll(/\b(?:bg|text|border)-primary(?:\/\d+)?\b/g);

        return Array.from(matches, (match) => `${file}:${lineNumber(source, match.index ?? 0)}:${match[0]}`);
      });

    expect(offenders).toEqual([]);
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

function lineNumber(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}

describe('visual style guide documentation', () => {
  it('documents the reusable grayscale glass component rules', () => {
    const guide = readFileSync('docs/visual-style-guide.md', 'utf8');

    expect(guide).toContain('ow-glass');
    expect(guide).toContain('components/ui/button.tsx');
    expect(guide).toContain('Avoid page-level `bg-primary`, `text-primary`, and `border-primary`');
  });
});
