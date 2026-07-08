// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBankFlow,
  startPracticeFlow,
  toggleBankFavoriteFlow
} from '@/lib/bank-flows';

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(data == null ? null : JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers
    }
  });
}

function requestPath(input: RequestInfo | URL) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;

  return new URL(input.url).pathname;
}

describe('bank browser flows', () => {
  const navigate = vi.fn();
  const fetchMock = vi.fn();

  beforeEach(() => {
    navigate.mockReset();
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates a bank through the browser API and navigates to the created bank route', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: {
        bank: {
          id: 11
        }
      }
    }, { status: 201 }));

    await createBankFlow({
      name: 'Biology 101',
      description: 'Cell structures',
      subject: 'biology',
      isPublic: true
    }, { navigate });

    expect(requestPath(fetchMock.mock.calls[0]?.[0] as RequestInfo | URL)).toBe('/api/v1/banks');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      name: 'Biology 101',
      description: 'Cell structures',
      subject: 'biology',
      isPublic: true
    });
    expect(navigate).toHaveBeenCalledWith('/banks/11');
  });

  it('favorites and unfavorites through the favorite endpoint with the matching HTTP verb', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, { status: 204 }));

    await toggleBankFavoriteFlow({ bankId: 11, nextFavorite: true });
    await toggleBankFavoriteFlow({ bankId: 11, nextFavorite: false });

    expect(requestPath(fetchMock.mock.calls[0]?.[0] as RequestInfo | URL)).toBe('/api/v1/banks/11/favorite');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include'
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();

    expect(requestPath(fetchMock.mock.calls[1]?.[0] as RequestInfo | URL)).toBe('/api/v1/banks/11/favorite');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'DELETE',
      credentials: 'include'
    });
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBeUndefined();
  });

  it('starts a practice session through the browser API and navigates to the session route', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: {
        id: 44
      }
    }, { status: 201 }));

    await startPracticeFlow({
      bankId: 11,
      sessionType: 'practice',
      questionCount: 25,
      mode: 'all',
      questionTypeId: null,
      allQuestions: true
    }, { navigate });

    expect(requestPath(fetchMock.mock.calls[0]?.[0] as RequestInfo | URL)).toBe('/api/v1/practice-sessions');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      bankId: 11,
      sessionType: 'practice',
      questionCount: 25,
      mode: 'all',
      questionTypeId: null,
      allQuestions: true
    });
    expect(navigate).toHaveBeenCalledWith('/practice/44');
  });
});
