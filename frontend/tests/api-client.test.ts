import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, apiRequest } from '@/lib/api';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('apiRequest', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('serializes JSON requests and unwraps the data envelope', async () => {
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
    expect(init.credentials).toBeUndefined();
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      login: 'alice@example.com',
      password: 'password123'
    });
  });

  it('throws ApiClientError with the consumed error fields', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            message: 'Invalid request',
            details: [{ field: 'email', message: 'Required' }]
          }
        },
        422
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
      message: 'Invalid request',
      details: [{ field: 'email', message: 'Required' }]
    });
  });
});
