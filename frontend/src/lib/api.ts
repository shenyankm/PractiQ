export class ApiClientError extends Error {
  status: number;
  code: string;
  details: unknown;
  requestId: string | null;

  constructor(options: { status: number; code: string; message: string; details: unknown; requestId: string | null }) {
    super(options.message);
    this.name = 'ApiClientError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.requestId = options.requestId;
  }
}

type ApiRequestOptions = {
  method?: string;
  json?: unknown;
  body?: BodyInit | null;
  headers?: HeadersInit;
};

function buildHeaders(options: ApiRequestOptions) {
  const headers = new Headers(options.headers);
  if (options.json !== undefined) headers.set('Content-Type', 'application/json');
  return headers;
}

export async function apiRequest<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: buildHeaders(options),
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body ?? null
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiClientError({
      status: response.status,
      code: error.code ?? 'UNKNOWN_ERROR',
      message: error.message ?? response.statusText,
      details: error.details ?? null,
      requestId: error.requestId ?? response.headers.get('x-request-id')
    });
  }
  return payload?.data as T;
}

