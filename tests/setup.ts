import { config } from 'dotenv';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

config({ path: '.env.local' });
config();

delete process.env.REDIS_URL;
process.env.POSTGRES_URL ||= process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/openwook_test';
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
