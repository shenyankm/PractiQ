import { File } from 'expo-file-system';
import type { ZodType } from 'zod';

import {
  CLOUD_API_URL,
  CloudError,
  cloudErrorFromResponse,
  cloudRequestEnvelope,
  currentSession,
  refreshStoredSession,
  type CloudEnvelope,
} from '@/cloud';
import {
  completeMutation,
  createMutationKey,
  enqueueMutation,
  failMutation,
  pendingMutations,
} from './cache';
import { shouldFailPermanently, shouldQueueAfterFailure } from './sync-policy';
import { importEventSchema, importJobSchema, type ImportEvent, type ImportJob } from './types';

export { CloudError as ApiError };

type RequestOptions = {
  method?: string;
  body?: unknown;
  rawBody?: BodyInit;
  headers?: HeadersInit;
  token?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  schema?: ZodType;
};

export type PendingImport = {
  bankId: number;
  file: { uri: string; name: string; type: string };
};

export type ApiPage<T> = {
  data: T;
  cursor: string;
  hasMore: boolean;
  limit: number;
};

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

async function requestEnvelope(path: string, options: RequestOptions): Promise<CloudEnvelope<unknown>> {
  const session = await currentSession();
  const token = session?.accessToken || options.token;
  const send = (accessToken: string | undefined) => cloudRequestEnvelope(path, {
    method: options.method,
    token: accessToken,
    json: options.body,
    body: options.rawBody,
    headers: options.headers,
    idempotencyKey: options.idempotencyKey,
    abortSignal: options.signal,
  });
  try {
    return await send(token);
  } catch (error) {
    if (error instanceof CloudError && error.status === 401 && token) {
      try {
        const refreshed = await refreshStoredSession(true);
        if (refreshed?.accessToken && refreshed.accessToken !== token) return await send(refreshed.accessToken);
      } catch {
        // The unauthenticated handler below clears React state after the refresh failure.
      }
    }
    if (error instanceof CloudError && (error.status === 401 || error.code === 'USER_INACTIVE')) {
      unauthorizedHandler?.();
    }
    throw error;
  }
}

function validateData<T>(data: unknown, schema?: ZodType): T {
  if (!schema) return data as T;
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new CloudError(
      '云端服务返回的数据格式无效。',
      200,
      'INVALID_RESPONSE',
      parsed.error.flatten(),
    );
  }
  return parsed.data as T;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const envelope = await requestEnvelope(path, options);
  return validateData<T>(envelope.data, options.schema);
}

export async function apiRequestPage<T>(path: string, options: RequestOptions = {}): Promise<ApiPage<T>> {
  const envelope = await requestEnvelope(path, options);
  const pagination = objectValue(envelope.meta, 'pagination');
  return {
    data: validateData<T>(envelope.data, options.schema),
    cursor: stringValue(pagination, 'cursor'),
    hasMore: pagination?.hasMore === true,
    limit: typeof pagination?.limit === 'number' ? pagination.limit : 0,
  };
}

export type ImportEventStreamOptions = {
  signal?: AbortSignal;
  lastEventId?: string;
  onEvent: (event: ImportEvent) => void | Promise<void>;
};

export async function streamImportJobEvents(
  jobId: number | string,
  options: ImportEventStreamOptions,
): Promise<void> {
  const cancelled = () => new CloudError('云端请求已取消。', 0, 'CANCELLED');
  if (options.signal?.aborted) throw cancelled();
  let session = await currentSession();
  if (!session) {
    unauthorizedHandler?.();
    throw cloudErrorFromResponse(401, null);
  }

  let token = session.accessToken;
  let lastEventId = options.lastEventId || '';
  const seenIds = new Set(lastEventId ? [lastEventId] : []);
  const open = async () => {
    const headers = new Headers({
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
    });
    if (lastEventId) headers.set('Last-Event-ID', lastEventId);
    try {
      return await fetch(`${CLOUD_API_URL}/api/v1/import-jobs/${encodeURIComponent(String(jobId))}/stream`, {
        method: 'GET',
        redirect: 'error',
        signal: options.signal,
        headers,
      });
    } catch {
      if (options.signal?.aborted) throw cancelled();
      throw new CloudError('无法连接云端服务，请检查网络。', 0, 'OFFLINE');
    }
  };

  const dispatch = async (frame: string) => {
    let frameId: string | undefined;
    const data: string[] = [];
    for (const line of frame.split(/\r\n|\r|\n/)) {
      if (!line || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'id' && !value.includes('\0')) frameId = value;
      if (field === 'data') data.push(value);
    }
    if (frameId !== undefined) lastEventId = frameId;
    if (!data.length) return false;

    let payload: unknown;
    try {
      payload = JSON.parse(data.join('\n'));
    } catch {
      throw new CloudError('云端服务返回的数据格式无效。', 200, 'INVALID_RESPONSE');
    }
    const parsed = importEventSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CloudError(
        '云端服务返回的数据格式无效。',
        200,
        'INVALID_RESPONSE',
        parsed.error.flatten(),
      );
    }
    const eventId = String(parsed.data.id);
    if (frameId === undefined) lastEventId = eventId;
    if (seenIds.has(eventId)) return false;
    seenIds.add(eventId);
    if (options.signal?.aborted) throw cancelled();
    await options.onEvent(parsed.data);
    return ['completed', 'failed', 'cancelled'].includes(parsed.data.status);
  };

  while (true) {
    if (options.signal?.aborted) throw cancelled();
    let response = await open();
    if (response.status === 401) {
      try {
        session = await refreshStoredSession(true);
        if (session?.accessToken && session.accessToken !== token) {
          token = session.accessToken;
          response = await open();
        }
      } catch {
        // The final 401 below drives the shared unauthenticated handler.
      }
    }
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const error = cloudErrorFromResponse(response.status, payload);
      if (error.status === 401 || error.code === 'USER_INACTIVE') unauthorizedHandler?.();
      throw error;
    }
    if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      throw new CloudError('云端服务返回的数据格式无效。', response.status, 'INVALID_RESPONSE');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const abort = () => { void reader.cancel().catch(() => undefined); };
    options.signal?.addEventListener('abort', abort, { once: true });
    let buffer = '';
    let terminal = false;
    try {
      if (options.signal?.aborted) throw cancelled();
      while (!terminal) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer) terminal = await dispatch(buffer);
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/.exec(buffer);
        while (boundary) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          terminal = await dispatch(frame);
          if (terminal) break;
          boundary = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/.exec(buffer);
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw cancelled();
      if (error instanceof CloudError) throw error;
      throw new CloudError('无法连接云端服务，请检查网络。', 0, 'OFFLINE');
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (terminal || options.signal?.aborted) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (terminal) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 250);
      function done() {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', done);
        resolve();
      }
      options.signal?.addEventListener('abort', done, { once: true });
      if (options.signal?.aborted) done();
    });
  }
}

function objectValue(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === 'object' ? nested as Record<string, unknown> : null;
}

function stringValue(value: Record<string, unknown> | null, key: string) {
  const nested = value?.[key];
  return typeof nested === 'string' ? nested : '';
}

export async function mutateOrQueue<T>(path: string, method: string, body?: unknown, schema?: ZodType<T>) {
  const mutationKey = createMutationKey();
  try {
    return {
      data: await apiRequest<T>(path, { method, body, idempotencyKey: mutationKey, schema }),
      queued: false,
    };
  } catch (error) {
    if (!(error instanceof CloudError) || !shouldQueueAfterFailure(error.status, error.code)) throw error;
    await enqueueMutation(method, path, body, mutationKey);
    return { data: null, queued: true };
  }
}

export async function flushOutbox() {
  for (const mutation of await pendingMutations()) {
    try {
      const body = mutation.body_json ? JSON.parse(mutation.body_json) : undefined;
      if (mutation.method === 'IMPORT') {
        const input = body as PendingImport;
        await uploadImport(input, mutation.mutation_key);
        const file = new File(input.file.uri);
        if (file.exists) file.delete();
      } else {
        await apiRequest(mutation.path, {
          method: mutation.method,
          body,
          idempotencyKey: mutation.mutation_key,
        });
      }
      await completeMutation(mutation.id);
    } catch (error) {
      if (error instanceof CloudError && shouldFailPermanently(error.status, error.code)) {
        await failMutation(mutation.id, error.message);
        continue;
      }
      break;
    }
  }
}

export async function uploadImport(input: PendingImport, idempotencyKey?: string) {
  const extension = input.file.name.split('.').pop()?.toLowerCase() || 'txt';
  const job = await apiRequest<ImportJob>('/api/v1/import-jobs', {
    method: 'POST',
    idempotencyKey: idempotencyKey ? `${idempotencyKey}-job` : undefined,
    body: {
      bankId: input.bankId,
      fileName: input.file.name,
      sourceType: extension,
      requestPayload: {},
    },
    schema: importJobSchema,
  });
  const form = new FormData();
  form.append('file', new File(input.file.uri));
  await apiRequest(`/api/v1/import-jobs/${job.id}/file`, {
    method: 'POST',
    rawBody: form,
    idempotencyKey: idempotencyKey ? `${idempotencyKey}-file` : undefined,
  });
  await apiRequest(`/api/v1/import-jobs/${job.id}/parse`, {
    method: 'POST',
    body: { persistQuestions: true },
    idempotencyKey: idempotencyKey ? `${idempotencyKey}-parse` : undefined,
  });
  return job;
}
