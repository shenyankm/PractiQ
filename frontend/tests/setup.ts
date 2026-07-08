import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const parsed: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (!key || key in parsed) continue;
    let value = trimmed.slice(index + 1).trim();
    if (value.length >= 2) {
      const quote = value[0];
      if ((quote === '"' || quote === '\'') && value[value.length - 1] === quote) {
        value = value.slice(1, -1);
      }
    }
    parsed[key] = value;
  }
  return parsed;
}

const dotenvLocal = readEnvFile(join('..', '.env.local'));
const dotenvDefault = readEnvFile(join('..', '.env'));
const configuredDatabaseUrl = process.env.POSTGRES_URL
  || process.env.DATABASE_URL
  || dotenvLocal.POSTGRES_URL
  || dotenvLocal.DATABASE_URL
  || dotenvDefault.POSTGRES_URL
  || dotenvDefault.DATABASE_URL
  || '';
const defaultDatabaseUrl = dotenvLocal.POSTGRES_URL
  || dotenvLocal.DATABASE_URL
  || dotenvDefault.POSTGRES_URL
  || dotenvDefault.DATABASE_URL
  || '';
const localDatabaseHost = (() => {
  if (!configuredDatabaseUrl) return false;
  try {
    const url = new URL(configuredDatabaseUrl);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
})();
if (
  process.env.OPENWOOK_ALLOW_INTEGRATION_TESTS !== '1'
  && configuredDatabaseUrl
  && !localDatabaseHost
  && !/(^|[_/-])test([_/-]|$)/i.test(configuredDatabaseUrl)
  && (process.env.OPENWOOK_SKIP_DB_TESTS !== '1' || configuredDatabaseUrl !== defaultDatabaseUrl)
) {
  throw new Error('tests/setup.ts requires a test database URL unless OPENWOOK_ALLOW_INTEGRATION_TESTS=1 is set for explicit integration testing.');
}

if (process.env.OPENWOOK_REDIS_TESTS !== '1') delete process.env.REDIS_URL;
process.env.POSTGRES_URL ||= configuredDatabaseUrl || 'postgres://test:test@localhost:5432/openwook_test';
process.env.AUTH_SECRET ||= 'test-auth-secret-for-vitest-only';
process.env.OBJECT_STORAGE_MOUNT_DIR = join(tmpdir(), `openwook-vitest-storage-${process.pid}`);
process.env.MOONSHOT_API_KEY = '';
process.env.DEEPSEEK_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.AI_APPLY_MIN_CONFIDENCE ||= '0.7';

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
