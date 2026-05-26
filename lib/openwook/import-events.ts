import type Redis from 'ioredis';
import {
  appendStreamJson,
  createRedisConnection,
  publishJson,
  redisKey
} from './redis';
import { errorToLog, logger } from './logger';

export type ImportEventPayload = {
  id?: number;
  job_id?: number;
  stage?: string;
  step_code?: string;
  step_label?: string | null;
  status?: string;
  message?: string | null;
  overall_progress_percent?: number | null;
  step_progress_percent?: number | null;
  target_kind?: string | null;
  target_name?: string | null;
  payload_json?: string;
  created_at?: string;
  [key: string]: unknown;
};

export function importEventChannel(jobId: number) {
  return redisKey('import', jobId, 'events');
}

export function importEventStreamKey(jobId: number) {
  return redisKey('stream', 'import', jobId, 'events');
}

export async function publishImportEvent(jobId: number, event: ImportEventPayload) {
  const payload = {
    ...event,
    job_id: event.job_id ?? jobId
  };
  await appendStreamJson(importEventStreamKey(jobId), payload);
  await publishJson(importEventChannel(jobId), payload);
}

function encodeSse(eventName: string, data: unknown, id?: string | number) {
  const lines = [
    id === undefined ? null : `id: ${id}`,
    `event: ${eventName}`,
    `data: ${JSON.stringify(data).replace(/\n/g, '\\n')}`,
    '',
    ''
  ].filter((line): line is string => line !== null);
  return lines.join('\n');
}

export function streamImportEvents(
  jobId: number,
  initialEvents: ImportEventPayload[],
  signal?: AbortSignal
) {
  const encoder = new TextEncoder();
  let subscriber: Redis | null = null;
  let keepAlive: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (value: string) => {
        try {
          controller.enqueue(encoder.encode(value));
        } catch {
          // The client already disconnected.
        }
      };

      enqueue('retry: 3000\n\n');
      for (const event of initialEvents) {
        enqueue(encodeSse('import-event', event, event.id));
      }

      subscriber = createRedisConnection('import-events-subscriber');
      if (!subscriber) {
        enqueue(encodeSse('stream-unavailable', { reason: 'REDIS_NOT_CONFIGURED' }));
        controller.close();
        return;
      }

      subscriber.on('message', (_channel, message) => {
        try {
          const event = JSON.parse(message) as ImportEventPayload;
          enqueue(encodeSse('import-event', event, event.id));
        } catch (error) {
          logger.warn({ ...errorToLog(error), jobId }, 'failed to parse import event payload');
          enqueue(encodeSse('import-event', { job_id: jobId, status: 'warning', message: 'Import event payload was unavailable.' }));
        }
      });

      subscriber.subscribe(importEventChannel(jobId)).catch((error) => {
        logger.warn({ ...errorToLog(error), jobId }, 'import event stream subscription failed');
        enqueue(encodeSse('stream-error', { message: 'Import event stream is temporarily unavailable.' }));
      });

      keepAlive = setInterval(() => enqueue(': keepalive\n\n'), 15000);

      signal?.addEventListener('abort', () => {
        if (keepAlive) clearInterval(keepAlive);
        subscriber?.disconnect();
        try {
          controller.close();
        } catch {
          // Ignore double-close races.
        }
      });
    },
    cancel() {
      if (keepAlive) clearInterval(keepAlive);
      subscriber?.disconnect();
    }
  });

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no'
    }
  });
}
