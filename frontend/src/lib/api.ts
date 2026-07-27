export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = '',
    readonly details: unknown = null,
    readonly requestId = ''
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

type ApiRequestOptions = {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: HeadersInit;
  signal?: AbortSignal;
};

type ApiEnvelope<T> = { data: T; meta: Record<string, unknown> | null };

export type ApiPage<T> = {
  data: T;
  cursor: string;
  hasMore: boolean;
  limit: number;
};

async function requestEnvelope<T>(url: string, options: ApiRequestOptions = {}): Promise<ApiEnvelope<T>> {
  const headers = new Headers(options.headers);
  if (options.json !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, {
    method: options.method,
    headers,
    body: options.json === undefined ? options.body : JSON.stringify(options.json),
    signal: options.signal
  });

  if (response.status === 204) return { data: undefined as T, meta: null };
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = objectValue(payload, 'error');
    throw new ApiClientError(
      stringValue(error, 'message') || response.statusText,
      response.status,
      stringValue(error, 'code'),
      objectValue(error, 'details') ?? null,
      stringValue(error, 'requestId')
    );
  }
  if (!payload || typeof payload !== 'object' || !('data' in payload)) {
    throw new ApiClientError('服务端返回的数据格式无效。', response.status, 'INVALID_RESPONSE');
  }
  return {
    data: (payload as { data: T }).data,
    meta: objectValue(payload, 'meta'),
  };
}

export async function apiRequest<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  return (await requestEnvelope<T>(url, options)).data;
}

export async function apiRequestPage<T>(url: string, options: ApiRequestOptions = {}): Promise<ApiPage<T>> {
  const envelope = await requestEnvelope<T>(url, options);
  const pagination = objectValue(envelope.meta, 'pagination');
  return {
    data: envelope.data,
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
