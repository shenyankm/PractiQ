import { config } from 'dotenv';
import type { Job } from 'bullmq';
import { trace } from '@opentelemetry/api';
import type { ImportJobQueueData } from './import-queue';
import type { User } from './types';

config({ path: '.env.local' });
config();

const { Worker } = await import('bullmq');
const { parseImportJobWithMastra } = await import('./ai');
const { sql } = await import('./db');
const { IMPORT_QUEUE_NAME, refreshImportQueueMetrics } = await import('./import-queue');
const { errorToLog, logger } = await import('./logger');
const { recordImportJobDuration, recordImportJobEvent } = await import('./metrics');
const { recordImportJobFailure } = await import('./services');
const { acquireRedisLock, createRedisConnection, redisKey } = await import('./redis');

const tracer = trace.getTracer('openwook-import-worker');
const activeJobStarts = new Map<string, number>();

async function loadWorkerUser(userId: number) {
  const rows = await sql<User[]>`
    SELECT id, username, email, avatar_url, is_active, role, membership, plus_trial_ends_at, plus_expires_at, created_at, updated_at
    FROM users
    WHERE id = ${userId}
      AND is_active = true
    LIMIT 1
  `;
  return rows[0] ?? null;
}

const connection = createRedisConnection('import-worker');
if (!connection) {
  logger.fatal('REDIS_URL is required to run the import worker.');
  process.exit(1);
}
const workerConnection = connection;

const worker = new Worker<ImportJobQueueData>(
  IMPORT_QUEUE_NAME,
  async (job: Job<ImportJobQueueData>) => tracer.startActiveSpan('import job parse', async (span) => {
    span.setAttributes({
      'messaging.system': 'bullmq',
      'messaging.destination.name': IMPORT_QUEUE_NAME,
      'openwook.import_job_id': job.data.jobId,
      'openwook.user_id': job.data.userId,
      'openwook.job_attempt': job.attemptsMade
    });

    const lock = await acquireRedisLock(
      redisKey('lock', 'import', job.data.jobId, 'parse'),
      Number(process.env.IMPORT_JOB_LOCK_TTL_MS || 30 * 60 * 1000)
    );
    if (!lock.acquired) {
      const error = new Error(`Import job ${job.data.jobId} is already being processed`);
      span.recordException(error);
      span.end();
      throw error;
    }

    try {
      const user = await loadWorkerUser(job.data.userId);
      if (!user) throw new Error(`Import worker user ${job.data.userId} is unavailable`);
      const result = await parseImportJobWithMastra(user, job.data.jobId, {
        persistQuestions: job.data.persistQuestions
      });
      span.end();
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.end();
      throw error;
    } finally {
      await lock.release();
    }
  }),
  {
    connection: workerConnection,
    concurrency: Number(process.env.IMPORT_WORKER_CONCURRENCY || 2)
  }
);

worker.on('active', (job) => {
  activeJobStarts.set(job.id ?? String(job.data.jobId), Date.now());
  recordImportJobEvent(IMPORT_QUEUE_NAME, 'active');
  void refreshImportQueueMetrics();
  logger.info({ queue: IMPORT_QUEUE_NAME, jobId: job.id, importJobId: job.data.jobId, userId: job.data.userId }, 'import job started');
});

worker.on('completed', (job) => {
  const key = job.id ?? String(job.data.jobId);
  const durationMs = Date.now() - (activeJobStarts.get(key) ?? Date.now());
  activeJobStarts.delete(key);
  recordImportJobEvent(IMPORT_QUEUE_NAME, 'completed');
  recordImportJobDuration(IMPORT_QUEUE_NAME, 'completed', durationMs);
  void refreshImportQueueMetrics();
  logger.info({ queue: IMPORT_QUEUE_NAME, jobId: job.id, importJobId: job.data.jobId, durationMs }, 'import job completed');
});

worker.on('failed', async (job, error) => {
  const key = job?.id ?? String(job?.data.jobId ?? 'unknown');
  const durationMs = Date.now() - (activeJobStarts.get(key) ?? Date.now());
  activeJobStarts.delete(key);
  recordImportJobEvent(IMPORT_QUEUE_NAME, 'failed');
  recordImportJobDuration(IMPORT_QUEUE_NAME, 'failed', durationMs);
  void refreshImportQueueMetrics();
  logger.error({ ...errorToLog(error), queue: IMPORT_QUEUE_NAME, jobId: job?.id, importJobId: job?.data.jobId, durationMs }, 'import job failed');
  if (!job) return;
  const maxAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade >= maxAttempts) {
    await recordImportJobFailure(job.data.jobId, error);
  }
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'closing import worker');
  await worker.close();
  workerConnection.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
