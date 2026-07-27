import { z } from 'zod';

import { validateQuestion } from './logic';
import type { ParsedQuestion, QuestionType } from './types';

// PractiQ cloud (openwook) API. All AI processing happens server-side; the app
// only sends plain HTTPS requests and renders the results.
export const CLOUD_API_URL =
  process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, '') || 'https://api.practiq.app';
export const CLOUD_PROVIDER_NAME = 'PractiQ 云端服务';

const SESSION_KEY = 'practiq.cloud.session';

export class CloudError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudError';
  }
}

export interface CloudSession {
  token: string;
  username: string;
}

export interface CloudRequestOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

// --- Restore guard -----------------------------------------------------------
// While a backup restore replaces the local database, in-flight cloud results
// must not be written back. Same mechanism the old local AI module used.
const activeRequests = new Map<AbortController, Promise<void>>();
let cloudQuiescing = false;
let cloudAuthorityGeneration = 0;

export async function quiesceCloudRequests() {
  cloudQuiescing = true;
  cloudAuthorityGeneration += 1;
  const pending = [...activeRequests.values()];
  for (const controller of activeRequests.keys()) controller.abort();
  await Promise.all(pending);
  return () => { cloudQuiescing = false; };
}

export function getCloudAuthorityGeneration() {
  return cloudAuthorityGeneration;
}

export function assertCloudAuthorityCurrent(generation: number) {
  if (generation !== cloudAuthorityGeneration || cloudQuiescing) {
    throw new CloudError('本地数据已恢复，旧云端结果已丢弃。');
  }
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

const sessionSchema = z.object({ token: z.string().min(1), username: z.string() });

export async function loadSession(): Promise<CloudSession | null> {
  try {
    const { SecureStore, options } = await secureStore();
    const raw = await SecureStore.getItemAsync(SESSION_KEY, options);
    if (!raw) return null;
    const parsed = sessionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function hasSession() {
  return Boolean(await loadSession());
}

async function saveSession(session: CloudSession) {
  const { SecureStore, options } = await secureStore();
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), options);
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
  error: z.object({ code: z.string(), message: z.string() }).loose(),
}).loose();

export function cloudErrorFromResponse(status: number, body: unknown): CloudError {
  const parsed = errorEnvelopeSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : '';
  if (status === 401) return new CloudError('登录已过期，请重新登录云端账户。');
  if (code === 'PLUS_REQUIRED') return new CloudError('此 AI 功能需要 Plus 会员，请联系管理员开通。');
  if (code === 'USER_INACTIVE') return new CloudError('该账户已被停用，请联系管理员。');
  if (code === 'VALIDATION_ERROR' || status === 422 || status === 400) {
    return new CloudError(parsed.success ? `请求无效：${parsed.data.error.message}` : '请求无效，请检查输入。');
  }
  if (status === 429) return new CloudError('云端服务当前请求过多，请稍后重试。');
  if (status >= 500) return new CloudError('云端服务暂时不可用，请稍后重试。');
  return new CloudError(parsed.success ? parsed.data.error.message : '云端请求失败，请稍后重试。');
}

async function request(
  path: string,
  body: unknown,
  options?: CloudRequestOptions & { token?: string },
): Promise<unknown> {
  if (cloudQuiescing) throw new CloudError('本地数据正在恢复，云端请求已取消。');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options?.abortSignal?.aborted) abort();
  else options?.abortSignal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, options?.timeoutMs ?? 120_000);
  let finish!: () => void;
  activeRequests.set(controller, new Promise((resolve) => { finish = resolve; }));
  try {
    let response: Response;
    try {
      response = await fetch(`${CLOUD_API_URL}${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      if (options?.abortSignal?.aborted) throw new CloudError('云端请求已取消。');
      if (controller.signal.aborted) throw new CloudError('云端请求超时，请检查网络后重试。');
      throw new CloudError('无法连接云端服务，请检查网络。');
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) await clearSession();
      throw cloudErrorFromResponse(response.status, payload);
    }
    if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
      throw new CloudError('云端服务返回的数据格式无效。');
    }
    return (payload as { data: unknown }).data;
  } finally {
    clearTimeout(timeout);
    options?.abortSignal?.removeEventListener('abort', abort);
    activeRequests.delete(controller);
    finish();
  }
}

async function authorizedRequest(path: string, body: unknown, options?: CloudRequestOptions) {
  const session = await loadSession();
  if (!session) throw new CloudError('请先在设置中登录 PractiQ 云端账户。');
  return request(path, body, { ...options, token: session.token });
}

// --- Auth --------------------------------------------------------------------

const authDataSchema = z.object({ username: z.string(), token: z.string().min(1) }).loose();

async function authenticate(path: string, body: unknown): Promise<CloudSession> {
  const data = authDataSchema.safeParse(await request(path, body, { timeoutMs: 30_000 }));
  if (!data.success) throw new CloudError('云端服务未返回会话令牌，请稍后重试。');
  const session = { token: data.data.token, username: data.data.username };
  await saveSession(session);
  return session;
}

export function login(loginName: string, password: string) {
  return authenticate('/api/v1/auth/login', { login: loginName, password });
}

export function register(username: string, email: string, password: string) {
  return authenticate('/api/v1/auth/register', { username, email, password });
}

export async function logout() {
  const session = await loadSession();
  if (session) {
    // Best effort: revoke server-side, but always drop the local token.
    await request('/api/v1/auth/logout', {}, { token: session.token, timeoutMs: 15_000 }).catch(() => undefined);
  }
  await clearSession();
}

// --- Server response mapping (trust boundary) --------------------------------

const serverOptionSchema = z.object({
  label: z.string().trim().min(1).max(10),
  content: z.string().trim().min(1).max(20_000),
  isCorrect: z.boolean().nullish(),
}).loose();

const serverAnswerMode = z.enum(['choice', 'true_false', 'fill_blank', 'short_answer']);

const serverContentBlockSchema = z.object({
  partType: z.string(),
  textValue: z.string().nullish(),
  markdownValue: z.string().nullish(),
  latexValue: z.string().nullish(),
}).loose();

const serverParsedQuestionSchema = z.object({
  stem: z.string().trim().min(1).max(20_000),
  answerMode: serverAnswerMode,
  options: z.array(serverOptionSchema).max(26).default([]),
  answerPayload: z.record(z.string(), z.unknown()).nullish(),
  analysis: z.string().max(20_000).nullish(),
  contentBlocks: z.array(serverContentBlockSchema).max(100).nullish(),
  confidence: z.number().min(0).max(1),
}).loose();

const parseDocumentDataSchema = z.object({
  questions: z.array(serverParsedQuestionSchema).min(1),
}).loose();

const generatedAnswerDataSchema = z.object({
  answerPayload: z.record(z.string(), z.unknown()).nullish(),
  canonicalAnswer: z.string().nullish(),
  explanation: z.string().max(20_000).default(''),
  confidence: z.number().min(0).max(1),
}).loose();

type ServerQuestion = z.output<typeof serverParsedQuestionSchema>;
type ServerAnswer = z.output<typeof generatedAnswerDataSchema>;

function stringList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
}

function choiceValues(payload: Record<string, unknown>, options: { label: string; isCorrect?: boolean | null }[]) {
  const raw = payload.correctOptions ?? payload.correctOption ?? payload.values;
  const values = stringList(raw);
  const fromFlags = options.filter((option) => option.isCorrect).map((option) => option.label);
  return (values.length ? values : fromFlags).map((value) => value.trim().toUpperCase());
}

// Maps the server's loose answerPayload conventions onto the app's answer
// shapes. Returns {} when nothing usable is present; imported questions stay
// drafts, so a missing answer is reviewed by the user rather than rejected.
export function answerFromServer(
  type: QuestionType,
  payload: Record<string, unknown> | null | undefined,
  options: { label: string; isCorrect?: boolean | null }[],
  canonical?: string | null,
): Record<string, unknown> {
  const source = payload ?? {};
  if (type === 'single_choice' || type === 'multiple_choice') {
    const values = choiceValues(source, options);
    return values.length ? { values } : {};
  }
  if (type === 'true_false') {
    const raw = source.value ?? source.correctOption ?? stringList(source.values)[0] ?? canonical;
    const text = typeof raw === 'boolean' ? String(raw) : String(raw ?? '').trim().toLowerCase();
    return text === 'true' || text === 'false' ? { values: [text] } : {};
  }
  if (type === 'fill_blank') {
    if (Array.isArray(source.blanks)) {
      const blanks = source.blanks.map((blank) => stringList(blank)).filter((blank) => blank.length);
      if (blanks.length) return { blanks };
    }
    const values = stringList(source.values ?? canonical);
    return values.length ? { blanks: values.map((value) => [value]) } : {};
  }
  const reference = [source.reference, source.value, canonical]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean);
  return reference ? { reference } : {};
}

const APP_CONTENT_BLOCK_KINDS = new Set(['formula', 'table', 'chart', 'mathml']);

function questionType(question: ServerQuestion): QuestionType {
  if (question.answerMode !== 'choice') return question.answerMode;
  // ponytail: the server does not distinguish single from multiple choice;
  // infer from the number of correct answers and let the user adjust drafts.
  const values = choiceValues(question.answerPayload ?? {}, question.options);
  return values.length > 1 ? 'multiple_choice' : 'single_choice';
}

export function mapParsedQuestion(question: ServerQuestion): ParsedQuestion {
  const type = questionType(question);
  const options = question.answerMode === 'choice'
    ? question.options.map((option, sortOrder) => ({
      label: option.label.toUpperCase(),
      content: option.content,
      sort_order: sortOrder,
    }))
    : [];
  const contentBlocks = (question.contentBlocks ?? []).flatMap((block) => {
    const content = (block.latexValue || block.markdownValue || block.textValue || '').trim();
    if (!APP_CONTENT_BLOCK_KINDS.has(block.partType) || !content) return [];
    return [{ kind: block.partType, content }];
  });
  return {
    stem: question.stem,
    type,
    options,
    answer: answerFromServer(type, question.answerPayload, question.options),
    explanation: (question.analysis ?? '').trim(),
    confidence: question.confidence,
    metadata: contentBlocks.length ? { contentBlocks } : undefined,
  };
}

export function mapGeneratedAnswer(
  input: { stem: string; type: QuestionType; options: { label: string; content: string }[] },
  data: ServerAnswer,
) {
  const answer = answerFromServer(input.type, data.answerPayload, input.options, data.canonicalAnswer);
  const errors = validateQuestion({
    stem: input.stem,
    type: input.type,
    status: 'active',
    options: input.options.map((option, sort_order) => ({ ...option, sort_order })),
    answer,
  });
  if (errors.length) throw new CloudError(`云端返回的答案无效：${errors.join('；')}`);
  return { answer, explanation: data.explanation.trim(), confidence: data.confidence };
}

// --- Learning report ---------------------------------------------------------
// Keeps the shape previously saved to the learning_reports table so existing
// saved reports keep rendering.
const reportTextSchema = (max: number) => z.string().trim().min(1).max(max);
const learningReportSchema = z.object({
  summary: reportTextSchema(4_000),
  mastery: z.array(z.object({
    area: reportTextSchema(200),
    score: z.number().min(0).max(1),
    evidence: reportTextSchema(2_000),
  }).loose()).max(30),
  weakPoints: z.array(z.object({
    area: reportTextSchema(200),
    evidence: reportTextSchema(2_000),
  }).loose()).max(30),
  recommendations: z.array(reportTextSchema(2_000)).min(1).max(20),
}).loose();
export type LearningReport = z.output<typeof learningReportSchema>;

export function parseLearningReport(value: unknown): LearningReport | null {
  const result = learningReportSchema.safeParse(value);
  return result.success ? result.data : null;
}

const serverReportSchema = z.object({
  summary: z.string().trim().min(1),
  mastery: z.array(z.object({
    label: z.string().trim().min(1),
    score: z.number().min(0).max(1),
    evidence: z.string().trim().min(1),
  }).loose()).default([]),
  weakPoints: z.array(z.object({
    label: z.string().trim().min(1),
    reason: z.string().trim(),
    suggestedAction: z.string().trim(),
  }).loose()).default([]),
  recommendations: z.array(z.string().trim().min(1)).min(1),
}).loose();

export function mapLearningReport(data: z.output<typeof serverReportSchema>): LearningReport {
  const clamp = (value: string, max: number) => value.slice(0, max);
  const report = {
    summary: clamp(data.summary, 4_000),
    mastery: data.mastery.slice(0, 30).map((item) => ({
      area: clamp(item.label, 200),
      score: item.score,
      evidence: clamp(item.evidence, 2_000),
    })),
    weakPoints: data.weakPoints.slice(0, 30).map((item) => ({
      area: clamp(item.label, 200),
      evidence: clamp([item.reason, item.suggestedAction].filter(Boolean).join(' '), 2_000) || clamp(item.label, 2_000),
    })),
    recommendations: data.recommendations.slice(0, 20).map((item) => clamp(item, 2_000)),
  };
  const parsed = learningReportSchema.safeParse(report);
  if (!parsed.success) throw new CloudError('云端服务返回的学习报告格式无效，请重试。');
  return parsed.data;
}

// --- AI endpoints -------------------------------------------------------------

export const MAX_CLOUD_DOCUMENT_CHARACTERS = 250_000;

export async function parseDocumentCloud(
  source: string,
  fileName: string,
  options?: CloudRequestOptions,
): Promise<ParsedQuestion[]> {
  const text = source.trim();
  if (!text || text.length > MAX_CLOUD_DOCUMENT_CHARACTERS) {
    throw new CloudError('文档内容为空或超过 250,000 个字符。');
  }
  const data = await authorizedRequest(
    '/api/v1/ai/parse-document',
    { sourceType: 'text', fileName, text },
    { ...options, timeoutMs: options?.timeoutMs ?? 300_000 },
  );
  const parsed = parseDocumentDataSchema.safeParse(data);
  if (!parsed.success) throw new CloudError('云端服务返回的解析结果格式无效，请重试。');
  return parsed.data.questions.map(mapParsedQuestion);
}

const ANSWER_MODES: Record<QuestionType, string> = {
  single_choice: 'choice',
  multiple_choice: 'choice',
  true_false: 'true_false',
  fill_blank: 'fill_blank',
  short_answer: 'short_answer',
};

export async function generateAnswerCloud(
  question: { stem: string; type: QuestionType; options: { label: string; content: string }[] },
  options?: CloudRequestOptions,
) {
  const stem = question.stem.trim();
  if (!stem || stem.length > 20_000) throw new CloudError('题目内容或选项格式无效。');
  const cleanOptions = question.options.map(({ label, content }) => ({
    label: label.trim().toUpperCase(),
    content: content.trim(),
  }));
  if ((question.type === 'single_choice' || question.type === 'multiple_choice') && cleanOptions.length < 2) {
    throw new CloudError('选择题至少需要两个选项。');
  }
  const data = await authorizedRequest(
    '/api/v1/ai/generate-answer',
    { stem, answerMode: ANSWER_MODES[question.type], options: cleanOptions },
    options,
  );
  const parsed = generatedAnswerDataSchema.safeParse(data);
  if (!parsed.success) throw new CloudError('云端服务返回的答案格式无效，请重试。');
  return mapGeneratedAnswer({ stem, type: question.type, options: cleanOptions }, parsed.data);
}

export async function learningReportCloud(stats: unknown, options?: CloudRequestOptions): Promise<LearningReport> {
  if (typeof stats !== 'object' || stats === null || !Object.keys(stats).length) {
    throw new CloudError('学习统计必须是非空 JSON 对象。');
  }
  if (JSON.stringify(stats).length > 100_000) throw new CloudError('学习统计超过 100,000 个字符。');
  const data = await authorizedRequest('/api/v1/ai/learning-report', { scope: 'individual', stats }, options);
  const parsed = serverReportSchema.safeParse(data);
  if (!parsed.success) throw new CloudError('云端服务返回的学习报告格式无效，请重试。');
  return mapLearningReport(parsed.data);
}
