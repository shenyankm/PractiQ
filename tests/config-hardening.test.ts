import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import nextConfig from '@/next.config';

type PackageManifest = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('config and tooling hardening', () => {
  it('adds basic security headers through next.config', async () => {
    const headers = await nextConfig.headers?.();
    const headerMap = new Map(
      (headers ?? []).flatMap((entry) => entry.headers.map((header) => [header.key.toLowerCase(), header.value] as const))
    );

    expect(Array.isArray(headers)).toBe(true);
    expect(headerMap.get('x-content-type-options')).toBe('nosniff');
    expect(headerMap.get('x-frame-options')).toBe('DENY');
    expect(headerMap.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(headerMap.has('content-security-policy')).toBe(true);
  });

  it('parses sensitive environment variables through a dedicated server-only env module', () => {
    const envModules = sourceFiles(['lib'])
      .filter((file) => /(?:^|\/)(?:env(?:\.server)?|server-env)\.ts$/.test(file));

    expect(envModules.length).toBeGreaterThan(0);
    expect(envModules.some((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes("import 'server-only'") || source.includes('import "server-only"');
    })).toBe(true);

    const offenders = sourceFiles(['app', 'lib'])
      .filter((file) => !envModules.includes(file))
      .filter((file) => !/^lib\/db\/(?:ensure-|seed|setup)/.test(file))
      .flatMap((file) => findSensitiveEnvReads(file));

    expect(offenders).toEqual([]);
  });

  it('refuses non-test database URLs during test setup by default', () => {
    const blocked = runSetupWithEnv({
      DATABASE_URL: 'postgres://prod:secret@db.example.com/openwook',
      POSTGRES_URL: '',
      OPENWOOK_ALLOW_INTEGRATION_TESTS: ''
    });

    expect(blocked.status).not.toBe(0);
    expect(`${blocked.stdout}\n${blocked.stderr}`).toMatch(/test database|integration/i);
  });

  it('allows an explicit integration-test override for non-test database URLs', () => {
    const allowed = runSetupWithEnv({
      DATABASE_URL: 'postgres://prod:secret@db.example.com/openwook',
      POSTGRES_URL: '',
      OPENWOOK_ALLOW_INTEGRATION_TESTS: '1'
    });

    expect(allowed.status).toBe(0);
  });

  it('only keeps next-themes installed when the app imports it', () => {
    const pkg = readPackageJson();
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    const usage = sourceFiles(['app', 'lib'])
      .filter((file) => readFileSync(file, 'utf8').includes('next-themes'));

    if (usage.length === 0) {
      expect(declared).not.toHaveProperty('next-themes');
      return;
    }

    expect(declared).toHaveProperty('next-themes');
  });

  it('keeps pnpm build approvals as booleans', () => {
    const values = allowBuildValues('pnpm-workspace.yaml');

    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => value === 'true' || value === 'false')).toBe(true);
  });

  it('exposes verify and Playwright e2e scripts from package.json', () => {
    const scripts = readPackageJson().scripts ?? {};

    expect(typeof scripts.verify).toBe('string');
    expect(scripts.verify).toMatch(/build/);
    expect(typeof scripts['test:e2e']).toBe('string');
    expect(scripts['test:e2e']).toMatch(/playwright/i);
  });

  it('ships icon and social metadata assets from the app directory', () => {
    expect(existsSync('app/favicon.ico')).toBe(true);
    expect(hasAny([
      'app/icon.png',
      'app/icon.jpg',
      'app/icon.jpeg',
      'app/icon.svg',
      'app/icon.ts',
      'app/icon.tsx'
    ])).toBe(true);
    expect(hasAny([
      'app/apple-icon.png',
      'app/apple-icon.jpg',
      'app/apple-icon.jpeg',
      'app/apple-icon.svg',
      'app/apple-icon.ts',
      'app/apple-icon.tsx'
    ])).toBe(true);
    expect(hasAny([
      'app/manifest.ts',
      'app/manifest.js',
      'app/manifest.webmanifest',
      'app/manifest.json'
    ])).toBe(true);
    expect(hasAny([
      'app/opengraph-image.png',
      'app/opengraph-image.jpg',
      'app/opengraph-image.jpeg',
      'app/opengraph-image.ts',
      'app/opengraph-image.tsx'
    ])).toBe(true);
    expect(hasAny([
      'app/twitter-image.png',
      'app/twitter-image.jpg',
      'app/twitter-image.jpeg',
      'app/twitter-image.ts',
      'app/twitter-image.tsx'
    ])).toBe(true);
  });

  it('defines a critical Playwright smoke spec for auth redirects, bank links, and settings validation', () => {
    const specPath = 'e2e/critical-flows.spec.ts';

    expect(existsSync(specPath)).toBe(true);

    const source = readFileSync(specPath, 'utf8');
    expect(source).toContain('@playwright/test');
    expect(source).toMatch(/sign-?in|auth redirect/i);
    expect(source).toMatch(/banks/i);
    expect(source).toMatch(/settings/i);
  });
});

function readPackageJson() {
  return JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;
}

function runSetupWithEnv(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx/esm',
      '--eval',
      "import('./tests/setup.ts').then(() => process.stdout.write('setup-ok'))"
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        ...env
      },
      encoding: 'utf8'
    }
  );
}

function allowBuildValues(path: string) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === 'allowBuilds:');
  if (start === -1) return [];

  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    const match = line.match(/^\s+[^:]+:\s*(.+)\s*$/);
    if (match) values.push(match[1]);
  }
  return values;
}

function hasAny(paths: string[]) {
  return paths.some((path) => existsSync(path));
}

function findSensitiveEnvReads(file: string) {
  const source = readFileSync(file, 'utf8');
  const matches = Array.from(
    source.matchAll(/process\.env\.(AUTH_SECRET|DATABASE_URL|POSTGRES_URL|METRICS_TOKEN|MOONSHOT_API_KEY|DEEPSEEK_API_KEY|OPENAI_API_KEY|PADDLE_API_KEY|PADDLE_CLIENT_TOKEN|PADDLE_WEBHOOK_SECRET|NEXT_PUBLIC_APP_URL|BASE_URL|OSS_PUBLIC_BASE_URL|OBJECT_STORAGE_PUBLIC_BASE_URL)\b/g)
  );

  return matches.map((match) => `${file}:${lineNumber(source, match.index ?? 0)}:${match[0]}`);
}

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
  return /\.(?:ts|tsx)$/.test(path);
}

function lineNumber(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}
