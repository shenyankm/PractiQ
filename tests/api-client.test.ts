import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, apiRequest } from '@/src/lib/api';

const fetchMock = vi.hoisted(() => vi.fn());
const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {})
    }
  });
}

function headerValue(headers: RequestInit['headers'] | undefined, name: string) {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return match?.[1] ?? null;
  }

  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? null;
}

describe('apiRequest', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends JSON requests with credentials included and unwraps the data envelope', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

    await expect(
      apiRequest('/api/v1/auth/login', {
        method: 'POST',
        json: {
          login: 'alice@example.com',
          password: 'password123'
        }
      })
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(headerValue(init.headers, 'Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      login: 'alice@example.com',
      password: 'password123'
    });
  });

  it('sends multipart requests with credentials included without forcing a content type header', async () => {
    const formData = new FormData();
    formData.set('username', 'alice');

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { username: 'alice' } }));

    await expect(
      apiRequest('/api/v1/users/me', {
        method: 'PATCH',
        body: formData
      })
    ).resolves.toEqual({ username: 'alice' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/users/me');
    expect(init.method).toBe('PATCH');
    expect(init.credentials).toBe('include');
    expect(init.body).toBe(formData);
    expect(headerValue(init.headers, 'Content-Type')).toBeNull();
  });

  it('throws ApiClientError with status, code, message, details, and requestId from the error envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request',
            details: [{ field: 'email', message: 'Required' }],
            requestId: 'req-123'
          }
        },
        422,
        { 'x-request-id': 'req-123' }
      )
    );

    const error = await apiRequest('/api/v1/auth/register', {
      method: 'POST',
      json: {
        username: 'alice',
        email: '',
        password: 'password123'
      }
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      details: [{ field: 'email', message: 'Required' }],
      requestId: 'req-123'
    });
  });
});
