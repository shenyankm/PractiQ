import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ALIPAY_APP_ID: z.string().optional(),
  ALIPAY_GATEWAY: z.string().optional(),
  ALIPAY_PID: z.string().optional(),
  ALIPAY_PLUS_MONTHLY_AMOUNT_CENTS: z.string().optional(),
  ALIPAY_PLUS_MONTHLY_SUBJECT: z.string().optional(),
  ALIPAY_PRIVATE_KEY: z.string().optional(),
  ALIPAY_PUBLIC_KEY: z.string().optional(),
  ANALYTICS_CACHE_TTL_SECONDS: z.string().optional(),
  AI_APPLY_MIN_CONFIDENCE: z.string().optional(),
  AI_CACHE_TTL_SECONDS: z.string().optional(),
  AI_REPORT_CACHE_TTL_SECONDS: z.string().optional(),
  ANSWER_KEY_CACHE_TTL_SECONDS: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  AVATAR_MAX_BYTES: z.string().optional(),
  BASE_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  HEALTH_CHECK_TIMEOUT_MS: z.string().optional(),
  IMPORT_JOB_LOCK_TTL_MS: z.string().optional(),
  IMPORT_QUEUE_ATTEMPTS: z.string().optional(),
  IMPORT_QUEUE_BACKOFF_MS: z.string().optional(),
  IMPORT_QUEUE_COMPLETE_COUNT: z.string().optional(),
  IMPORT_QUEUE_COMPLETE_TTL_SECONDS: z.string().optional(),
  IMPORT_QUEUE_FAIL_COUNT: z.string().optional(),
  IMPORT_QUEUE_FAIL_TTL_SECONDS: z.string().optional(),
  IMPORT_QUEUE_NAME: z.string().optional(),
  IMPORT_SOURCE_MAX_BYTES: z.string().optional(),
  IMPORT_WORKER_CONCURRENCY: z.string().optional(),
  KIMI_THINKING_ENABLED: z.string().optional(),
  KIMI_THINKING_KEEP: z.string().optional(),
  KIMI_THINKING_TYPE: z.string().optional(),
  LEADERBOARD_CACHE_TTL_SECONDS: z.string().optional(),
  LOG_LEVEL: z.string().optional(),
  METRICS_TOKEN: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().optional(),
  OBJECT_STORAGE_MOUNT_DIR: z.string().optional(),
  OBJECT_STORAGE_PUBLIC_BASE_URL: z.string().optional(),
  OBJECT_STORAGE_URL_PREFIX: z.string().optional(),
  OPENWOOK_REFERENCE_CACHE_TTL_SECONDS: z.string().optional(),
  OPENWOOK_SHORT_CACHE_TTL_SECONDS: z.string().optional(),
  OSS_MOUNT_DIR: z.string().optional(),
  OSS_PUBLIC_BASE_URL: z.string().optional(),
  OSS_URL_PREFIX: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
  POSTGRES_CONNECT_TIMEOUT_SECONDS: z.string().optional(),
  POSTGRES_IDLE_TIMEOUT_SECONDS: z.string().optional(),
  POSTGRES_POOL_MAX: z.string().optional(),
  POSTGRES_URL: z.string().optional(),
  PRACTICE_MAX_QUESTIONS: z.string().optional(),
  PRACTICE_PROGRESS_FULL_LIMIT: z.string().optional(),
  PRACTICE_PROGRESS_WINDOW_RADIUS: z.string().optional(),
  PRACTICE_QUEUE_TTL_SECONDS: z.string().optional(),
  REDIS_KEY_PREFIX: z.string().optional(),
  REDIS_URL: z.string().optional(),
  SLOW_QUERY_MS: z.string().optional()
}).passthrough();

type Env = z.infer<typeof envSchema>;

function currentEnv() {
  return envSchema.parse(process.env);
}

export const env = new Proxy({} as Env, {
  get(_target, property) {
    return currentEnv()[property as keyof Env];
  }
});
