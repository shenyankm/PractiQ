import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Violation = `${string}:${number}:${string}` | `${string}:${string}`;

const SELF_PATH = 'tests/heroui-policy.test.ts';
const SRC_TS_FILES = projectFiles(['src'], isTsFile);
const SRC_TSX_FILES = projectFiles(['src'], isTsxFile);
const TEST_TSX_FILES = projectFiles(['tests'], (path) => isTsxFile(path) && path !== SELF_PATH);
const POLICY_TEXT_FILES = projectFiles(['src', 'tests', '../docs', 'package.json'], isPolicyTextFile)
  .filter((path) => path !== SELF_PATH);

const FORBIDDEN_UI_PACKAGES = [
  '@/components/' + 'ui/',
  '@/lib/' + 'utils',
  '@mui/',
  '@material-ui/',
  'antd',
  '@chakra-ui/',
  '@mantine/',
  '@emotion/',
  'styled-components',
  'class-variance-authority',
  'tailwind-variants',
  'framer-motion'
] as const;

const FORBIDDEN_DEPENDENCIES = [
  '@mui/material',
  '@material-ui/core',
  'antd',
  '@chakra-ui/react',
  '@mantine/core',
  '@emotion/react',
  'styled-components',
  'class-variance-authority',
  'framer-motion'
] as const;

const OLD_VISUAL_RESIDUE = ['ow-glass', 'ow-surface', 'ow-focus', 'tw-animate-css'] as const;

describe('HeroUI-only policy guardrails', () => {
  it('keeps forbidden UI packages out of src and tests', () => {
    const violations = sourceImportViolations([...SRC_TSX_FILES, ...TEST_TSX_FILES]);
    expect(violations).toEqual([]);
  });

  it('keeps forbidden UI dependencies out of package.json', () => {
    expect(forbiddenDependencyViolations()).toEqual([]);
  });

  it('uses root @heroui/react imports for Button references', () => {
    const offenders = SRC_TSX_FILES.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('Button')) return [];
      return importsHeroButton(source) ? [] : [`${file}:missing-root-heroui-button-import` as const];
    });
    expect(offenders).toEqual([]);
  });

  it('does not shadow official HeroUI package types', () => {
    const violations = SRC_TS_FILES.flatMap((file) => matchLines(file, /declare\s+module\s+['"]@heroui\/react['"]/g));
    expect(violations).toEqual([]);
  });

  it('keeps visible form controls on HeroUI components', () => {
    const rawControls = /<(?:label|select|textarea)\b|<input\b(?![^>]*\btype=['"]hidden['"])/g;
    const violations = SRC_TSX_FILES.flatMap((file) => matchLines(file, rawControls));
    expect(violations).toEqual([]);
  });

  it('uses HeroUI semantic variants instead of legacy Button color props', () => {
    const violations = SRC_TSX_FILES.flatMap((file) => matchLines(file, /<Button\b[^>\n]*\bcolor=/g));
    expect(violations).toEqual([]);
  });

  it('gives progress bars an accessible name', () => {
    const violations = SRC_TSX_FILES.flatMap((file) => matchLines(file, /<ProgressBar\b(?![^>\n]*(?:aria-label|aria-labelledby))/g));
    expect(violations).toEqual([]);
  });

  it('typechecks before Vite production builds', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.build).toMatch(/tsc\s+--noEmit\s+&&\s+vite build/);
  });

  it('keeps old visual residue out of source and policy text', () => {
    const residue = OLD_VISUAL_RESIDUE.flatMap((token) => {
      const pattern = new RegExp(`\\b${escapeRegex(token)}\\b`, 'g');
      return POLICY_TEXT_FILES.flatMap((file) => matchLines(file, pattern));
    });
    expect(residue).toEqual([]);
  });
});

function forbiddenDependencyViolations(): Violation[] {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync('package.json', 'utf8')) as typeof pkg;
  } catch (error) {
    return [`package.json:${error instanceof Error ? error.message : 'unreadable'}`];
  }
  const installed = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  return FORBIDDEN_DEPENDENCIES.flatMap((name) => installed.has(name) ? [`package.json:${name}` as const] : []);
}

function sourceImportViolations(files: string[]): Violation[] {
  return files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return FORBIDDEN_UI_PACKAGES.flatMap((value) => matchSource(file, source, new RegExp(escapeRegex(value), 'g')));
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

function isTsFile(path: string) {
  return path.endsWith('.ts') || path.endsWith('.tsx');
}

function isPolicyTextFile(path: string) {
  return /\.(?:css|json|md|ts|tsx)$/.test(path);
}

function matchLines(file: string, pattern: RegExp): Violation[] {
  return matchSource(file, readFileSync(file, 'utf8'), pattern);
}

function matchSource(file: string, source: string, pattern: RegExp): Violation[] {
  return Array.from(source.matchAll(pattern), (match) => `${file}:${lineNumber(source, match.index ?? 0)}:${match[0]}` as Violation);
}

function lineNumber(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
