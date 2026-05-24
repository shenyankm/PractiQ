import { config } from 'dotenv';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

config({ path: '.env.local' });
config();

process.env.POSTGRES_URL ||= process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/openwook_test';
process.env.AUTH_SECRET ||= 'test-auth-secret-for-vitest-only';
process.env.OBJECT_STORAGE_MOUNT_DIR = join(tmpdir(), `openwook-vitest-storage-${process.pid}`);
process.env.MOONSHOT_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.AI_APPLY_MIN_CONFIDENCE ||= '0.7';
