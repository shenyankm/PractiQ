import { z } from 'zod';

// PractiQ cloud (practiq) API. All AI processing happens server-side; the app
// only sends plain HTTPS requests and renders the results.
export const CLOUD_API_URL =
  process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, '') || 'https://api.practiq.app';
if (process.env.NODE_ENV === 'production' && !CLOUD_API_URL.startsWith('https://')) {
  throw new Error('EXPO_PUBLIC_API_URL must use HTTPS in production.');
}
const SESSION_KEY = 'practiq.cloud.session';

export class CloudError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = '',
    readonly details: unknown = null,
    readonly requestId = '',
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

export interface CloudSession {
  accessToken: string;
  refreshToken: string;
  username: string;
  expiresAt: string;
  refreshExpiresAt: string;
}

export interface CloudRequestOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export interface CloudHTTPRequestOptions extends CloudRequestOptions {
  method?: string;
  token?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: HeadersInit;
  idempotencyKey?: string;
}

// --- Session storage ---------------------------------------------------------

async function secureStore() {
  const SecureStore = await import('expo-secure-store');
  if (!(await SecureStore.isAvailableAsync())) {
    throw new CloudError('当前设备不支持安全存储，云端功能不可用。');
  }
  const options: import('expo-secure-store').SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    keychainService: 'practiq.cloud',
  };
  return { SecureStore, options };
}

const sessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  username: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  refreshExpiresAt: z.iso.datetime({ offset: true }),
});

export async function loadSession(): Promise<CloudSession | null> {
  try {
    const { SecureStore, options } = await secureStore();
    const raw = await SecureStore.getItemAsync(SESSION_KEY, options);
    if (!raw) return null;
    const parsed = sessionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || Date.parse(parsed.data.refreshExpiresAt) <= Date.now()) {
      await SecureStore.deleteItemAsync(SESSION_KEY, options);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

async function saveSession(session: CloudSession) {
  const { SecureStore, options } = await secureStore();
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), options);
}

const tokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  refreshExpiresAt: z.iso.datetime({ offset: true }),
  tokenType: z.literal('Bearer'),
});

let refreshInFlight: Promise<CloudSession | null> | null = null;

export async function refreshStoredSession(force = false): Promise<CloudSession | null> {
  const saved = await loadSession();
  if (!saved) return null;
  if (!force && Date.parse(saved.expiresAt) > Date.now() + 60_000) return saved;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const payload = tokenSchema.safeParse(await cloudRequest('/api/v1/auth/refresh', {
      method: 'POST',
      json: { refreshToken: saved.refreshToken },
      timeoutMs: 30_000,
    }));
    if (!payload.success) throw new CloudError('云端服务未返回更新后的会话令牌。');
    const session = { ...saved, ...payload.data };
    await saveSession(session);
    return session;
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export function currentSession() {
  return refreshStoredSession();
}

export async function clearSession() {
  try {
    const { SecureStore, options } = await secureStore();
    await SecureStore.deleteItemAsync(SESSION_KEY, options);
  } catch {
    // Nothing sensitive is kept if deletion fails; the token simply expires.
  }
}

// --- HTTP --------------------------------------------------------------------

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }).loose(),
}).loose();
const successEnvelopeSchema = z.object({
  data: z.unknown(),
  meta: z.record(z.string(), z.unknown()).optional(),
}).loose();

export type CloudEnvelope<T> = {
  data: T;
  meta: Record<string, unknown>;
};

export function cloudErrorFromResponse(status: number, body: unknown): CloudError {
  const parsed = errorEnvelopeSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : '';
  const details = parsed.success ? parsed.data.error.details ?? null : null;
  const requestId = parsed.success ? parsed.data.error.requestId ?? '' : '';
  if (status === 401) return new CloudError('登录已过期，请重新登录云端账户。', status, code, details, requestId);
  if (code === 'PRO_REQUIRED') return new CloudError('此云端 AI 功能需要 PRO 订阅。', status, code, details, requestId);
  if (code === 'ORGANIZATION_REQUIRED') return new CloudError('此功能需要 Organization 订阅。', status, code, details, requestId);
  if (code === 'LLM_CONFIG_REQUIRED') return new CloudError('请先在设置中配置你的 LLM API Key。', status, code, details, requestId);
  if (code === 'VISION_MODEL_REQUIRED') return new CloudError('此文档需要配置视觉模型。', status, code, details, requestId);
  if (code === 'USER_INACTIVE') return new CloudError('该账户已被停用，请联系管理员。', status, code, details, requestId);
  if (code === 'VALIDATION_ERROR' || status === 422 || status === 400) {
    return new CloudError(
      parsed.success ? `请求无效：${parsed.data.error.message}` : '请求无效，请检查输入。',
      status,
      code,
      details,
      requestId,
    );
  }
  if (status === 429) return new CloudError('云端服务当前请求过多，请稍后重试。', status, code, details, requestId);
  if (status >= 500) return new CloudError('云端服务暂时不可用，请稍后重试。', status, code, details, requestId);
  return new CloudError(
    parsed.success ? parsed.data.error.message : '云端请求失败，请稍后重试。',
    status,
    code,
    details,
    requestId,
  );
}

export async function cloudRequestEnvelope<T = unknown>(
  path: string,
  options: CloudHTTPRequestOptions = {},
): Promise<CloudEnvelope<T>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.abortSignal?.aborted) abort();
  else options.abortSignal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, options.timeoutMs ?? 120_000);
  try {
    const headers = new Headers(options.headers);
    if (options.json !== undefined) headers.set('Content-Type', 'application/json');
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
    let response: Response;
    try {
      response = await fetch(`${CLOUD_API_URL}${path}`, {
        method: options.method,
        redirect: 'error',
        signal: controller.signal,
        headers,
        body: options.json === undefined ? options.body : JSON.stringify(options.json),
      });
    } catch {
      if (options.abortSignal?.aborted) throw new CloudError('云端请求已取消。', 0, 'CANCELLED');
      if (controller.signal.aborted) throw new CloudError('云端请求超时，请检查网络后重试。', 0, 'TIMEOUT');
      throw new CloudError('无法连接云端服务，请检查网络。', 0, 'OFFLINE');
    }
    const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const error = cloudErrorFromResponse(response.status, payload);
      if (response.status === 401 || error.code === 'USER_INACTIVE') await clearSession();
      throw error;
    }
    if (response.status === 204) return { data: undefined as T, meta: {} };
    const parsed = successEnvelopeSchema.safeParse(payload);
    if (!parsed.success) throw new CloudError('云端服务返回的数据格式无效。', response.status, 'INVALID_RESPONSE');
    return { data: parsed.data.data as T, meta: parsed.data.meta || {} };
  } finally {
    clearTimeout(timeout);
    options.abortSignal?.removeEventListener('abort', abort);
  }
}

export async function cloudRequest<T = unknown>(
  path: string,
  options: CloudHTTPRequestOptions = {},
): Promise<T> {
  return (await cloudRequestEnvelope<T>(path, options)).data;
}

function request(
  path: string,
  body: unknown,
  options?: CloudRequestOptions & { token?: string },
) {
  return cloudRequest(path, { ...options, method: 'POST', json: body });
}

// --- Auth --------------------------------------------------------------------

const authDataSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().min(1),
  email: z.string().email().nullable(),
  is_active: z.boolean(),
  role: z.enum(['admin', 'user']),
  membership: z.enum(['free', 'pro', 'organization']),
  trialEndsAt: z.string().nullable().optional(),
  effectiveMembership: z.enum(['free', 'pro', 'organization']).optional(),
  revenuecat_app_user_id: z.uuid(),
  tokens: tokenSchema,
}).loose();

async function authenticate(path: string, body: unknown): Promise<CloudSession> {
  const data = authDataSchema.safeParse(await request(path, body, { timeoutMs: 30_000 }));
  if (!data.success) throw new CloudError('云端服务未返回会话令牌，请稍后重试。');
  const session = {
    ...data.data.tokens,
    username: data.data.username,
  };
  await saveSession(session);
  return session;
}

export function login(loginName: string, password: string) {
  return authenticate('/api/v1/auth/login', { login: loginName, password });
}

export function register(username: string, email: string, password: string, code: string) {
  return authenticate('/api/v1/auth/register', { username, email, password, code });
}

export function sendEmailCode(email: string) {
  return cloudRequest('/api/v1/auth/email-code', { method: 'POST', json: { email }, timeoutMs: 30_000 });
}

export function loginWithGoogle(idToken: string) {
  return authenticate('/api/v1/auth/google/token', { idToken });
}

export async function logout() {
  const session = await loadSession();
  if (session) {
    // Best effort: revoke server-side, but always drop the local token.
    await request('/api/v1/auth/logout', {}, { token: session.accessToken, timeoutMs: 15_000 }).catch(() => undefined);
  }
  await clearSession();
}
