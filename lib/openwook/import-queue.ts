import { Queue, type JobsOptions } from 'bullmq';
import { errorToLog, logger } from './logger';
import { setImportQueueCounts } from './metrics';
import { createRedisConnection, isRedisConfigured, redisKey } from './redis';
import { env } from './env';

export const IMPORT_QUEUE_NAME = env.IMPORT_QUEUE_NAME || redisKey('queue', 'imports');

export type ImportJobQueueData = {
  jobId: number;
  userId: number;
  persistQuestions: boolean;
  requestedAt: string;
};

let importQueue: Queue<ImportJobQueueData> | null | undefined;

export function isImportQueueConfigured() {
  return isRedisConfigured();
}

export function getImportQueue() {
  if (!isImportQueueConfigured()) return null;
  if (importQueue === undefined) {
    const connection = createRedisConnection('import-queue');
    importQueue = connection
      ? new Queue<ImportJobQueueData>(IMPORT_QUEUE_NAME, { connection })
      : null;
  }
  return importQueue;
}

export async function enqueueImportJob(data: Omit<ImportJobQueueData, 'requestedAt'>, options?: JobsOptions) {
  const queue = getImportQueue();
  if (!queue) return null;
  return queue.add(
    'parse',
    {
      ...data,
      requestedAt: new Date().toISOString()
    },
    {
      jobId: String(data.jobId),
      attempts: Number(env.IMPORT_QUEUE_ATTEMPTS || 3),
      backoff: {
        type: 'exponential',
        delay: Number(env.IMPORT_QUEUE_BACKOFF_MS || 5000)
      },
      removeOnComplete: {
        age: Number(env.IMPORT_QUEUE_COMPLETE_TTL_SECONDS || 86400),
        count: Number(env.IMPORT_QUEUE_COMPLETE_COUNT || 1000)
      },
      removeOnFail: {
        age: Number(env.IMPORT_QUEUE_FAIL_TTL_SECONDS || 604800),
        count: Number(env.IMPORT_QUEUE_FAIL_COUNT || 1000)
      },
      ...options
    }
  );
}

export async function removeQueuedImportJob(jobId: number) {
  const queue = getImportQueue();
  if (!queue) return false;
  const job = await queue.getJob(String(jobId));
  if (!job) return false;
  const state = await job.getState();
  if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
    await job.remove();
    return true;
  }
  return false;
}

export async function refreshImportQueueMetrics() {
  const queue = getImportQueue();
  if (!queue) return null;
  try {
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused', 'prioritized', 'waiting-children');
    setImportQueueCounts(IMPORT_QUEUE_NAME, counts);
    return counts;
  } catch (error) {
    logger.warn({ ...errorToLog(error), queue: IMPORT_QUEUE_NAME }, 'failed to refresh import queue metrics');
    return null;
  }
}
