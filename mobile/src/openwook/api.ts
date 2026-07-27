import { File } from 'expo-file-system';

import { clearSession, CLOUD_API_URL, loadSession } from '@/cloud';
import {
  completeMutation,
  createMutationKey,
  enqueueMutation,
  failMutation,
  pendingMutations,
} from './cache';
import { shouldFailPermanently, shouldQueueAfterFailure } from './sync-policy';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code = '') {
    super(message);
    this.name = 'ApiError';
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  token?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type PendingImport = {
  bankId: number;
  file: { uri: string; name: string; type: string };
};

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const session = options.token ? null : await loadSession();
  const token = options.token || session?.token;
  let response: Response;
  try {
    response = await fetch(`${CLOUD_API_URL}${path}`, {
      method: options.method,
      redirect: 'error',
      signal: options.signal,
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError('当前处于离线状态。', 0, 'OFFLINE');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = payload && typeof payload === 'object' && 'error' in payload
      ? (payload as { error?: { code?: string; message?: string } }).error
      : undefined;
    if (response.status === 401) {
      await clearSession();
      unauthorizedHandler?.();
    }
    throw new ApiError(envelope?.message || `HTTP ${response.status}`, response.status, envelope?.code || '');
  }
  if (response.status === 204) return undefined as T;
  if (!payload || typeof payload !== 'object' || !('data' in payload)) {
    throw new ApiError('服务端返回的数据格式无效。', response.status, 'INVALID_RESPONSE');
  }
  return (payload as { data: T }).data;
}

export async function mutateOrQueue<T>(path: string, method: string, body?: unknown) {
  const mutationKey = createMutationKey();
  try {
    return {
      data: await apiRequest<T>(path, { method, body, idempotencyKey: mutationKey }),
      queued: false,
    };
  } catch (error) {
    if (!(error instanceof ApiError) || !shouldQueueAfterFailure(error.status, error.code)) throw error;
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
      if (error instanceof ApiError && shouldFailPermanently(error.status)) {
        await failMutation(mutation.id, error.message);
        continue;
      }
      break;
    }
  }
}

export async function uploadImport(input: PendingImport, idempotencyKey?: string) {
  const extension = input.file.name.split('.').pop()?.toLowerCase() || 'txt';
  const job = await apiRequest<{ id: number }>('/api/v1/import-jobs', {
    method: 'POST',
    idempotencyKey: idempotencyKey ? `${idempotencyKey}-job` : undefined,
    body: {
      bankId: input.bankId,
      fileName: input.file.name,
      sourceType: extension,
      requestPayload: {},
    },
  });
  const session = await loadSession();
  const form = new FormData();
  form.append('file', input.file as unknown as Blob);
  let response: Response;
  try {
    response = await fetch(`${CLOUD_API_URL}/api/v1/import-jobs/${job.id}/file`, {
      method: 'POST',
      headers: session ? { Authorization: `Bearer ${session.token}` } : {},
      body: form,
    });
  } catch {
    throw new ApiError('当前处于离线状态。', 0, 'OFFLINE');
  }
  if (!response.ok) throw new ApiError(`上传失败（HTTP ${response.status}）`, response.status);
  await apiRequest(`/api/v1/import-jobs/${job.id}/parse`, {
    method: 'POST',
    body: { persistQuestions: true },
    idempotencyKey: idempotencyKey ? `${idempotencyKey}-parse` : undefined,
  });
  return job;
}
