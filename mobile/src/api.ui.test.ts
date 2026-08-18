// api.ts + cloud.ts tests over a mocked global fetch and in-memory secure store.
import * as cloudModule from './cloud';
import { CloudError, cloudRequestEnvelope, loadSession, login, logout, sendEmailCode } from './cloud';
import { apiRequest, apiRequestPage, flushOutbox, mutateOrQueue, setUnauthorizedHandler, streamImportJobEvents, uploadImport } from './practiq/api';

const mockSecureStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  isAvailableAsync: jest.fn<any, any[]>(async () => true),
  getItemAsync: jest.fn<any, any[]>(async (key: string) => mockSecureStore.get(key) ?? null),
  setItemAsync: jest.fn<any, any[]>(async (key: string, value: string) => { mockSecureStore.set(key, value); }),
  deleteItemAsync: jest.fn<any, any[]>(async (key: string) => { mockSecureStore.delete(key); }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlocked',
}));

jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    exists = false;
    delete() { /* no-op */ }
  },
}));

const mockEnqueued: [string, string, unknown, string][] = [];
const mockCompleted: number[] = [];
const mockFailed: [number, string][] = [];

jest.mock('./practiq/cache', () => ({
  createMutationKey: () => `mutation-${Math.random().toString(36).slice(2)}`,
  enqueueMutation: async (method: string, path: string, body: unknown, key: string) => {
    mockEnqueued.push([method, path, body, key]);
    return key;
  },
  pendingMutations: async () => [
    { id: 1, mutation_key: 'k1', method: 'POST', path: '/api/v1/banks', body_json: '{"name":"B"}', state: 'pending', last_error: null },
    { id: 2, mutation_key: 'k2', method: 'IMPORT', path: '/import', body_json: JSON.stringify({ bankId: 1, file: { uri: 'file:///a.txt', name: 'a.txt', type: 'text/plain' } }), state: 'pending', last_error: null },
    { id: 3, mutation_key: 'k3', method: 'POST', path: '/api/v1/banks', body_json: null, state: 'pending', last_error: null },
  ],
  completeMutation: async (id: number) => { mockCompleted.push(id); },
  failMutation: async (id: number, message: string) => { mockFailed.push([id, message]); },
}));

beforeAll(() => {
  global.fetch = jest.fn<any, any[]>();
});

beforeEach(() => {
  mockSecureStore.clear();
  mockEnqueued.length = 0;
  mockCompleted.length = 0;
  mockFailed.length = 0;
  (global.fetch as jest.Mock).mockReset();
});

function mockFetch(status: number, body: unknown) {
  return (global.fetch as jest.Mock).mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

describe('apiRequest', () => {
  it('returns validated data on success', async () => {
    mockFetch(200, { data: { id: 7, stem: 'S' }, meta: {} });
    const result = await apiRequest<{ id: number; stem: string }>('/api/v1/questions/7');
    expect(result.id).toBe(7);
  });

  it('throws INVALID_RESPONSE when the schema rejects the payload', async () => {
    mockFetch(200, { data: { id: 'not-a-number' } });
    const { z } = jest.requireActual('zod');
    await expect(apiRequest('/api/v1/questions/7', { schema: z.object({ id: z.number() }) }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('triggers the unauthorized handler on 401', async () => {
    mockFetch(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } });
    const handler = jest.fn<any, any[]>();
    const remove = setUnauthorizedHandler(handler);
    await expect(apiRequest('/api/v1/auth/me')).rejects.toBeInstanceOf(CloudError);
    expect(handler).toHaveBeenCalled();
    remove();
    await expect(apiRequest('/api/v1/auth/me')).rejects.toBeInstanceOf(CloudError);
    expect(handler).toHaveBeenCalledTimes(1);
    setUnauthorizedHandler(null);
  });

  it('parses pagination meta in apiRequestPage', async () => {
    mockFetch(200, { data: [1, 2], meta: { pagination: { cursor: 'abc', hasMore: true, limit: 50 } } });
    const page = await apiRequestPage('/api/v1/banks');
    expect(page).toEqual({ data: [1, 2], cursor: 'abc', hasMore: true, limit: 50 });
    mockFetch(200, { data: [], meta: {} });
    const empty = await apiRequestPage('/api/v1/banks');
    expect(empty.hasMore).toBe(false);
    expect(empty.cursor).toBe('');
  });
});

describe('mutateOrQueue', () => {
  it('sends directly when online', async () => {
    mockFetch(200, { data: { id: 1 } });
    const result = await mutateOrQueue('/api/v1/banks', 'POST', { name: 'B' });
    expect(result).toEqual({ data: { id: 1 }, queued: false });
    expect(mockEnqueued).toHaveLength(0);
  });

  it('queues when the failure is retryable', async () => {
    mockFetch(503, { error: { code: 'UNAVAILABLE', message: 'x' } });
    const result = await mutateOrQueue('/api/v1/banks', 'POST', { name: 'B' });
    expect(result).toEqual({ data: null, queued: true });
    expect(mockEnqueued).toHaveLength(1);
    expect(mockEnqueued[0][1]).toBe('/api/v1/banks');
  });

  it('rethrows permanent failures', async () => {
    mockFetch(422, { error: { code: 'VALIDATION_ERROR', message: 'bad' } });
    await expect(mutateOrQueue('/api/v1/banks', 'POST', {})).rejects.toBeInstanceOf(CloudError);
    expect(mockEnqueued).toHaveLength(0);
  });
});

describe('flushOutbox', () => {
  it('replays mutations, uploads imports, and parks permanent failures', async () => {
    const fetchMock = (global.fetch as jest.Mock);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {}, meta: {} }), { status: 200 })) // banks mutation
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: validImportJob(), meta: {} }), { status: 201 })) // import job
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, meta: {} }), { status: 200 })) // file upload
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, meta: {} }), { status: 200 })) // parse
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {}, meta: {} }), { status: 200 })); // banks mutation 3
    await flushOutbox();
    expect(mockCompleted).toEqual([1, 2, 3]);
    expect(mockFailed).toHaveLength(0);
  });

  it('parks permanently mockFailed mutations and stops on transient errors', async () => {
    const fetchMock = (global.fetch as jest.Mock);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'no' } }), { status: 422 }));
    await flushOutbox();
    expect(mockFailed).toEqual([[1, expect.stringMatching(/no/)]]);
    expect(mockCompleted).toHaveLength(0);
  });
});

describe('uploadImport', () => {
  it('creates the job, uploads the file, and starts parsing', async () => {
    const fetchMock = (global.fetch as jest.Mock);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: validImportJob(), meta: {} }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, meta: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, meta: {} }), { status: 200 }));
    const job = await uploadImport({ bankId: 1, file: { uri: 'file:///q.txt', name: 'q.txt', type: 'text/plain' } }, 'mk');
    expect(job.id).toBe(99);
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(String(calls[0][1].headers.get('Idempotency-Key'))).toBe('mk-job');
    expect(String(calls[1][1].headers.get('Idempotency-Key'))).toBe('mk-file');
    expect(String(calls[2][1].headers.get('Idempotency-Key'))).toBe('mk-parse');
    expect(calls[1][1].body).toBeInstanceOf(FormData);
  });
});

describe('streamImportJobEvents', () => {
  const encoder = new TextEncoder();
  const event = (id: number, status: string) => ({
    id,
    job_id: 99,
    stage: status,
    step_code: `step-${id}`,
    step_label: null,
    status,
    message: null,
    overall_progress_percent: status === 'completed' ? 100 : 25,
    step_progress_percent: null,
    target_kind: null,
    target_name: null,
    payload_json: '{}',
    created_at: '2026-08-18T00:00:00Z',
  });
  const response = (chunks: string[], cancel?: () => void) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (chunks.length) controller.close();
    },
    cancel,
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

  beforeEach(() => {
    jest.spyOn(cloudModule, 'currentSession').mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      username: 'u',
      expiresAt: '2099-01-01T00:00:00Z',
      refreshExpiresAt: '2099-02-01T00:00:00Z',
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('parses split chunks, ignores heartbeats, deduplicates, and reconnects with its cursor', async () => {
    const first = `: heartbeat\r\n\r\nid: 1\r\ndata: ${JSON.stringify(event(1, 'processing'))}\r\n\r\n`;
    const second = `id: 1\ndata: ${JSON.stringify(event(1, 'processing'))}\n\nid: 2\ndata: ${JSON.stringify(event(2, 'completed'))}\n\n`;
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(response([first.slice(0, 17), first.slice(17, 61), first.slice(61)]))
      .mockResolvedValueOnce(response([second]));
    const received: number[] = [];

    await streamImportJobEvents(99, { onEvent: (value) => { received.push(value.id); } });

    expect(received).toEqual([1, 2]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const firstHeaders = (global.fetch as jest.Mock).mock.calls[0][1].headers as Headers;
    const reconnectHeaders = (global.fetch as jest.Mock).mock.calls[1][1].headers as Headers;
    expect(firstHeaders.get('Authorization')).toBe('Bearer access-token');
    expect(firstHeaders.get('Accept')).toBe('text/event-stream');
    expect(reconnectHeaders.get('Last-Event-ID')).toBe('1');
  });

  it('rejects malformed event data through the import event schema', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(response(['id: 1\ndata: {"id":"bad"}\n\n']));
    await expect(streamImportJobEvents(99, { onEvent: jest.fn() }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('cancels a pending stream through AbortSignal', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(response([]));
    const controller = new AbortController();
    const pending = streamImportJobEvents(99, { signal: controller.signal, onEvent: jest.fn() });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await rejection;
    expect((global.fetch as jest.Mock).mock.calls[0][1].signal).toBe(controller.signal);
  });
});

function validImportJob() {
  return {
    id: 99,
    bank_id: 1,
    status: 'queued',
    stage: 'queued',
    file_name: 'a.txt',
    imported_questions: 0,
    total_questions: 0,
    overall_progress_percent: null,
    last_error: null,
  };
}

function validAuthData(token: string) {
  return {
    id: 1,
    username: 'u',
    email: null,
    is_active: true,
    role: 'user',
    membership: 'free',
    revenuecat_app_user_id: '00000000-0000-0000-0000-000000000000',
    token,
    expiresAt: '2099-01-01T00:00:00Z',
  };
}

describe('cloud request layer', () => {
  it('handles 204 and invalid envelopes', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(cloudRequestEnvelope('/x')).resolves.toEqual({ data: undefined, meta: {} });
    (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    await expect(cloudRequestEnvelope('/x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('maps offline and pre-aborted requests', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('network down'));
    await expect(cloudRequestEnvelope('/x')).rejects.toMatchObject({ code: 'OFFLINE' });
    const controller = new AbortController();
    controller.abort();
    (global.fetch as jest.Mock).mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    await expect(cloudRequestEnvelope('/x', { abortSignal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('login fails cleanly when the secure store is unavailable; logout is safe without a session', async () => {
    // expo-secure-store is not importable under jest CJS, so saveSession/loadSession
    // fall into their catch paths: login rejects, logout only clears.
    (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(JSON.stringify({ data: validAuthData('t1'), meta: {} }), { status: 200 }));
    await expect(login('u', 'p')).rejects.toBeDefined();
    (global.fetch as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ data: { ok: true }, meta: {} }), { status: 200 }));
    await expect(sendEmailCode('u@example.com')).resolves.toEqual({ ok: true });
    await logout();
    expect(await loadSession()).toBeNull();
  });

  it('rejects invalid login responses and expired sessions', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(JSON.stringify({ data: { bad: 1 } }), { status: 200 }));
    await expect(login('u', 'p')).rejects.toBeInstanceOf(CloudError);
    mockSecureStore.set('practiq.cloud.session', JSON.stringify({ token: 't', username: 'u', expiresAt: '2000-01-01T00:00:00Z' }));
    expect(await loadSession()).toBeNull();
  });
});
