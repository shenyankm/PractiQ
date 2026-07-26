export class ApiClientError extends Error {
  constructor(message: string, readonly details: unknown) {
    super(message);
  }
}

type ApiRequestOptions = {
  method?: string;
  json?: unknown;
};

export async function apiRequest<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method,
    headers: options.json === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.json === undefined ? undefined : JSON.stringify(options.json)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiClientError(error.message ?? response.statusText, error.details ?? null);
  }
  return payload?.data as T;
}
