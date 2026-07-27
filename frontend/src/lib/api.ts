export class ApiClientError extends Error {
  constructor(message: string, readonly details: unknown) {
    super(message);
  }
}

type ApiRequestOptions = {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: HeadersInit;
  signal?: AbortSignal;
};

export async function apiRequest<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method,
    headers: options.json === undefined
      ? options.headers
      : { ...options.headers, 'Content-Type': 'application/json' },
    body: options.json === undefined ? options.body : JSON.stringify(options.json),
    signal: options.signal
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiClientError(error.message ?? response.statusText, error.details ?? null);
  }
  return payload?.data as T;
}
