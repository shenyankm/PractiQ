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
