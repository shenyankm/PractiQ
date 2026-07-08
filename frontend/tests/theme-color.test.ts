import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('brand color system', () => {
  it('does not leave orange Tailwind utility classes in src UI', () => {
    const offenders = tsxFiles('src').flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes('orange') ? [file] : [];
    });
    expect(offenders).toEqual([]);
  });

  it('uses semantic neutral colors instead of page-level slate or gray utilities', () => {
    const offenders = tsxFiles('src').flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const matches = source.matchAll(/\b(?:bg|text|border|placeholder)-(?:slate|gray)-\d{2,3}\b/g);
      return Array.from(matches, (match) => `${file}:${lineNumber(source, match.index ?? 0)}:${match[0]}`);
    });
    expect(offenders).toEqual([]);
  });

  it('keeps the global visual system on Tailwind then HeroUI import order', () => {
    const globals = readFileSync('src/styles/globals.css', 'utf8');
    expect(globals).toContain('@import "tailwindcss";');
    expect(globals).toContain('@import "@heroui/styles";');
    expect(globals.indexOf('@import "tailwindcss";')).toBeLessThan(globals.indexOf('@import "@heroui/styles";'));
  });

  it('keeps page-level primary emphasis out of src routes', () => {
    const offenders = tsxFiles('src').flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const matches = source.matchAll(/\b(?:bg|text|border)-primary(?:\/\d+)?\b/g);
      return Array.from(matches, (match) => `${file}:${lineNumber(source, match.index ?? 0)}:${match[0]}`);
    });
    expect(offenders).toEqual([]);
  });
});

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
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
  it('documents HeroUI-only component and variant rules', () => {
    const guide = readFileSync('../docs/visual-style-guide.md', 'utf8');
    expect(guide).toContain('HeroUI semantic variants');
    expect(guide).toContain('Import standard components directly from `@heroui/react`.');
    expect(guide).toContain('Avoid page-level `bg-primary`, `text-primary`, and `border-primary`');
    expect(guide).not.toMatch(/\bow-[\w-]+\b/);
  });
});
