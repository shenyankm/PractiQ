import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Violation = `${string}:${number}:${string}` | `${string}:${string}`;

const SELF_PATH = 'tests/heroui-policy.test.ts';
const APP_TSX_FILES = projectFiles(['app'], isTsxFile);
const TEST_TSX_FILES = projectFiles(['tests'], (path) => isTsxFile(path) && path !== SELF_PATH);
const POLICY_TEXT_FILES = projectFiles(['app', 'tests', 'docs', 'package.json'], isPolicyTextFile)
  .filter((path) => path !== SELF_PATH);

const FORBIDDEN_UI_PACKAGES = [
  '@/components/' + 'ui/',
  '@/lib/' + 'utils',
  '@mui/',
  '@material-ui/',
  'antd',
  '@radix-ui/',
  '@headlessui/',
  '@chakra-ui/',
  '@mantine/',
  'styled-components',
  '@emotion/',
  'class-variance-authority',
  'clsx',
  'tailwind-merge'
] as const;

const FORBIDDEN_DEPENDENCIES = [
  '@mui/material',
  '@mui/icons-material',
  '@material-ui/core',
  '@material-ui/icons',
  'antd',
  '@radix-ui/react-slot',
  '@radix-ui/react-dialog',
  '@headlessui/react',
  '@chakra-ui/react',
  '@mantine/core',
  '@mantine/hooks',
  'styled-components',
  '@emotion/react',
  '@emotion/styled',
  'class-variance-authority',
  'clsx',
  'tailwind-merge',
  'tw-animate-css'
] as const;
const OLD_VISUAL_RESIDUE = ['ow-glass', 'ow-surface', 'ow-focus', 'tw-animate-css'] as const;


describe('HeroUI-only policy guardrails', () => {
  it('forbids third-party UI imports and package dependencies outside HeroUI', () => {
    const packageViolations = forbiddenDependencyViolations();
    const sourceViolations = sourceImportViolations([...APP_TSX_FILES, ...TEST_TSX_FILES]);

    expect([...packageViolations, ...sourceViolations]).toEqual([]);
  });

  it('requires root @heroui/react imports instead of subpath imports', () => {
    const violations = [...APP_TSX_FILES, ...TEST_TSX_FILES]
      .flatMap((file) => matchLines(file, /from\s+['"](@heroui\/react\/[^'"]+)['"]/g));

    expect(violations).toEqual([]);
  });

  it('forbids legacy button BEM classes in app routes', () => {
    const violations = APP_TSX_FILES
      .flatMap((file) => matchLines(file, /\bbutton button--[\w-]+\b/g));

    expect(violations).toEqual([]);
  });

  it('forbids visible raw select, radio, and checkbox controls in app routes while allowing hidden inputs', () => {
    const violations = APP_TSX_FILES.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [
        ...matchSource(file, source, /<select\b/g),
        ...matchSource(file, source, /<input\b[^>]*type\s*=\s*(?:\{\s*)?['"](?:radio|checkbox)['"](?:\s*\})?[^>]*>/g)
      ];
    });

    expect(violations).toEqual([]);
  });

  it('requires HeroUI Button interactions to use onPress instead of onClick', () => {
    const violations = APP_TSX_FILES.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return importsHeroButton(source)
        ? matchSource(file, source, /<Button\b[^>]*\bonClick\s*=/g)
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('forbids the old custom visual system residue across app, package, tests, and docs', () => {
    const violations = POLICY_TEXT_FILES.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return OLD_VISUAL_RESIDUE.flatMap((token) => matchSource(file, source, new RegExp(escapeRegex(token), 'g')));
    });

    expect(violations).toEqual([]);
  });
});

function forbiddenDependencyViolations(): Violation[] {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };

  return Object.keys(declared)
    .filter((name) => FORBIDDEN_DEPENDENCIES.includes(name as (typeof FORBIDDEN_DEPENDENCIES)[number]))
    .map((name) => `package.json:dependency:${name}`);
}

function sourceImportViolations(files: string[]): Violation[] {
  return files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');

    return FORBIDDEN_UI_PACKAGES.flatMap((token) => {
      if (token.startsWith('@/')) {
        return matchSource(file, source, new RegExp(`['\"]${escapeRegex(token)}`, 'g'));
      }

      return matchSource(file, source, new RegExp(`from\\s+['\"]${escapeRegex(token)}[^'\"]*['\"]`, 'g'));
    });
  });
}

function importsHeroButton(source: string) {
  return /import\s*\{[^}]*\bButton\b[^}]*\}\s*from\s*['"]@heroui\/react(?:\/[^'"]+)?['"]/.test(source);
}

function projectFiles(paths: string[], include: (path: string) => boolean): string[] {
  return paths.flatMap((path) => walk(path, include));
}

function walk(path: string, include: (path: string) => boolean): string[] {
  const stats = statSync(path);

  if (stats.isDirectory()) {
    return readdirSync(path).flatMap((entry) => walk(join(path, entry), include));
  }

  return include(path) ? [path] : [];
}

function isTsxFile(path: string) {
  return path.endsWith('.tsx');
}

function isPolicyTextFile(path: string) {
  return /\.(?:css|json|md|ts|tsx)$/.test(path);
}

function matchLines(file: string, pattern: RegExp): Violation[] {
  return matchSource(file, readFileSync(file, 'utf8'), pattern);
}

function matchSource(file: string, source: string, pattern: RegExp): Violation[] {
  return Array.from(source.matchAll(pattern), (match) => `${file}:${lineNumber(source, match.index ?? 0)}:${match[0]}`);
}

function lineNumber(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
