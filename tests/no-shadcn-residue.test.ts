import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('no shadcn/radix component layer residue', () => {
  it('does not keep the shadcn component directory or registry config', () => {
    expect(existsSync('components/ui')).toBe(false);
    expect(existsSync('components.json')).toBe(false);
  });

  it('does not depend on the shadcn helper packages directly', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };

    expect(declared).not.toHaveProperty('radix-ui');
    expect(declared).not.toHaveProperty('sonner');
    expect(declared).not.toHaveProperty('class-variance-authority');
    expect(declared).not.toHaveProperty('clsx');
    expect(declared).not.toHaveProperty('tailwind-merge');
  });

  it('does not import the removed shadcn component or cn utility paths', () => {
    const offenders = sourceFiles(['app', 'lib', 'tests', 'docs', 'README.md', 'AGENTS.md'])
      .filter((file) => file !== 'tests/no-shadcn-residue.test.ts')
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        return source.includes('@/components/ui/') || source.includes('@/lib/utils')
          ? [file]
          : [];
      });

    expect(offenders).toEqual([]);
  });
});

function sourceFiles(dirs: string[]): string[] {
  return dirs.flatMap((dir) => walk(dir));
}

function walk(path: string): string[] {
  if (!existsSync(path)) return [];
  const stats = statSync(path);

  if (!stats.isDirectory()) return isSource(path) ? [path] : [];

  return readdirSync(path)
    .flatMap((entry) => walk(join(path, entry)));
}

function isSource(path: string) {
  return /\.(?:ts|tsx|md)$/.test(path);
}
