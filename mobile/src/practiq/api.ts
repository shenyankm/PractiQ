import { File } from 'expo-file-system';
import type { ZodType } from 'zod';

import { CloudError, cloudRequestEnvelope, loadSession, type CloudEnvelope } from '@/cloud';
import {
  completeMutation,
  createMutationKey,
  enqueueMutation,
  failMutation,
  pendingMutations,
} from './cache';
import { shouldFailPermanently, shouldQueueAfterFailure } from './sync-policy';
import { importJobSchema, type ImportJob } from './types';

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
  const session = options.token ? null : await loadSession();
  const token = options.token || session?.token;
  try {
    return await cloudRequestEnvelope(path, {
      method: options.method,
      token,
      json: options.body,
      body: options.rawBody,
      headers: options.headers,
      idempotencyKey: options.idempotencyKey,
      abortSignal: options.signal,
    });
  } catch (error) {
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
