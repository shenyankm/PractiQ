import { config } from 'dotenv';
import type { Job } from 'bullmq';
import type { ImportJobQueueData } from './import-queue';
import type { User } from './types';

config({ path: '.env.local' });
config();

const { Worker } = await import('bullmq');
const { parseImportJobWithMastra } = await import('./ai');
const { sql } = await import('./db');
const { IMPORT_QUEUE_NAME } = await import('./import-queue');
const { recordImportJobFailure } = await import('./services');
const { acquireRedisLock, createRedisConnection, redisKey } = await import('./redis');

async function loadWorkerUser(userId: number) {
  const rows = await sql<User[]>`
    SELECT id, username, email, is_active, role, membership, plus_trial_ends_at, created_at, updated_at
    FROM users
    WHERE id = ${userId}
      AND is_active = true
    LIMIT 1
  `;
  return rows[0] ?? null;
}

const connection = createRedisConnection('import-worker');
if (!connection) {
  console.error('REDIS_URL is required to run the import worker.');
  process.exit(1);
}
const workerConnection = connection;

const worker = new Worker<ImportJobQueueData>(
  IMPORT_QUEUE_NAME,
  async (job: Job<ImportJobQueueData>) => {
    const lock = await acquireRedisLock(
      redisKey('lock', 'import', job.data.jobId, 'parse'),
      Number(process.env.IMPORT_JOB_LOCK_TTL_MS || 30 * 60 * 1000)
    );
    if (!lock.acquired) {
      throw new Error(`Import job ${job.data.jobId} is already being processed`);
    }

    try {
      const user = await loadWorkerUser(job.data.userId);
      if (!user) throw new Error(`Import worker user ${job.data.userId} is unavailable`);
      return await parseImportJobWithMastra(user, job.data.jobId, {
        persistQuestions: job.data.persistQuestions
      });
    } finally {
      await lock.release();
    }
  },
  {
    connection: workerConnection,
    concurrency: Number(process.env.IMPORT_WORKER_CONCURRENCY || 2)
  }
);

worker.on('active', (job) => {
  console.log(`Import job ${job.data.jobId} started`);
});

worker.on('completed', (job) => {
  console.log(`Import job ${job.data.jobId} completed`);
});

worker.on('failed', async (job, error) => {
  console.error(`Import job ${job?.data.jobId ?? 'unknown'} failed`, error);
  if (!job) return;
  const maxAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade >= maxAttempts) {
    await recordImportJobFailure(job.data.jobId, error);
  }
});

async function shutdown(signal: string) {
  console.log(`Received ${signal}; closing import worker`);
  await worker.close();
  workerConnection.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
