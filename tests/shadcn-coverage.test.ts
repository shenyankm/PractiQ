import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const structuralFiles = new Set([
  'app/layout.tsx',
  'app/(login)/layout.tsx',
  'app/(login)/sign-in/page.tsx',
  'app/(login)/sign-up/page.tsx',
  'app/(openwook)/layout.tsx',
  'app/(openwook)/page.tsx'
]);

describe('shadcn/ui coverage', () => {
  it('keeps visible app surfaces covered by shadcn/ui imports', () => {
    const offenders = tsxFiles('app')
      .filter((file) => !structuralFiles.has(file))
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return source.includes('return (') && !source.includes('@/components/ui/');
      });

    expect(offenders).toEqual([]);
  });

  it('uses shadcn form controls instead of raw visible controls', () => {
    const offenders = tsxFiles('app')
      .flatMap((file) => findRawVisibleControls(file));

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

function findRawVisibleControls(file: string) {
  const source = readFileSync(file, 'utf8');
  const patterns = [
    /<select\b/g,
    /<textarea\b/g,
    /<input\b(?![^>]*\btype=["']hidden["'])/g
  ];

  return patterns.flatMap((pattern) =>
    Array.from(source.matchAll(pattern), (match) => `${file}:${lineNumber(source, match.index ?? 0)}`)
  );
}

function lineNumber(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}
