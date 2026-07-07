import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const retiredFiles = [
  'drizzle.config.ts',
  'lib/db/drizzle.ts',
  'lib/db/schema.ts',
  'lib/db/queries.ts',
  'lib/auth/session.ts',
  'lib/auth/middleware.ts'
];

const retiredReferences = [
  'drizzle.config.ts',
  'lib/db/drizzle.ts',
  'lib/db/schema.ts',
  'lib/db/queries.ts',
  'lib/auth/session.ts',
  'lib/auth/middleware.ts',
  '@/lib/db/drizzle',
  '@/lib/db/schema',
  '@/lib/db/queries',
  '@/lib/auth/session',
  '@/lib/auth/middleware'
];

describe('starter Drizzle/team retirement contract', () => {
  it('removes the retired starter files and migration entrypoints', () => {
    for (const file of retiredFiles) {
      expect(existsSync(file), `${file} should be gone`).toBe(false);
    }

    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts).not.toHaveProperty('db:generate');
    expect(pkg.scripts).not.toHaveProperty('db:migrate');
    expect(pkg.scripts).not.toHaveProperty('db:studio');
  });

  it('does not leave source, tests, or docs pointing at the retired starter layer', () => {
    const offenders = ['app', 'lib', 'tests', 'docs', 'README.md']
      .flatMap((path) => walk(path))
      .filter((file) => file !== 'tests/drizzle-client-reuse.test.ts')
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        const hits = retiredReferences.filter((reference) => source.includes(reference));
        return hits.length > 0 ? [`${file}: ${hits.join(', ')}`] : [];
      });

    expect(offenders).toEqual([]);
  });
});

function walk(path: string): string[] {
  if (!existsSync(path)) return [];
  const stats = statSync(path);

  if (!stats.isDirectory()) return /\.(?:ts|tsx|md)$/.test(path) ? [path] : [];

  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}
