import { config } from 'dotenv';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dotenvLocal = config({ path: '.env.local' });
const dotenvDefault = config();

const configuredDatabaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
const defaultDatabaseUrl = dotenvLocal.parsed?.POSTGRES_URL
  || dotenvLocal.parsed?.DATABASE_URL
  || dotenvDefault.parsed?.POSTGRES_URL
  || dotenvDefault.parsed?.DATABASE_URL
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

delete process.env.REDIS_URL;
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
