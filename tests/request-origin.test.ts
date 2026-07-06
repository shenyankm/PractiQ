import { describe, expect, it } from 'vitest';
import { assertSameOriginRequest, isSameOriginRequest } from '@/lib/openwook/request-origin';
import { ApiError } from '@/lib/openwook/api';

describe('same-origin write request guard', () => {
  it('allows same-origin requests', () => {
    const request = new Request('https://openwook.cloud/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://openwook.cloud'
      }
    });

    expect(isSameOriginRequest(request)).toBe(true);
    expect(() => assertSameOriginRequest(request)).not.toThrow();
  });

  it('rejects cross-site requests that can carry session cookies', () => {
    const request = new Request('https://openwook.cloud/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example'
      }
    });

    expect(isSameOriginRequest(request)).toBe(false);
    expect(() => assertSameOriginRequest(request)).toThrow(ApiError);
  });

  it('falls back to forwarded host and proto behind a reverse proxy', () => {
    const request = new Request('http://127.0.0.1:3000/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://openwook.cloud',
        'x-forwarded-host': 'openwook.cloud',
        'x-forwarded-proto': 'https'
      }
    });

    expect(isSameOriginRequest(request)).toBe(true);
  });
});
