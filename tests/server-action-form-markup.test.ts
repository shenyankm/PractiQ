import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('server action form markup', () => {
  it('does not override React-managed method or encType on function action forms', () => {
    const offenders = tsxFiles('app')
      .flatMap((file) => findServerActionFormOverrides(file));

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

function findServerActionFormOverrides(file: string) {
  const source = readFileSync(file, 'utf8');
  const matches = source.matchAll(/<form\b(?=[^>]*\baction=\{[^}]+\})[^>]*\b(?:encType|method)=/gs);

  return Array.from(matches, (match) => `${file}:${lineNumber(source, match.index ?? 0)}`);
}

function lineNumber(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}
