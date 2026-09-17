export interface Envelope<T> { data: T; meta?: { pagination: Pagination } }
export interface Pagination { cursor: string; limit: number; hasMore: boolean }
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export type Mode = 'choice' | 'true_false' | 'fill_blank' | 'short_answer' | 'ordering' | 'matching';
export interface Bank { id: number; subject_id: string; name: string; description: string; is_favorite: boolean }
export interface Option { id: number; option_label: string | null; content: string | null; sort_order: number }
export interface Item { id: number; side: 'left' | 'right' | null; content: string | null; sort_order: number }
export interface Key { id: number; version: number; is_primary: boolean; answer_payload: Record<string, unknown>; explanation_payload: Record<string, unknown> }
export interface Media { id: number; media_id: number; mime_type: string; original_name?: string }
export interface Block { id: number; part_type: string; payload: { textValue?: string; markdownValue?: string; latexValue?: string; jsonValue?: unknown } }
export interface Group { id: number; title: string; instructions: string; status: string; subset_id: number | null; sort_order: number; content_blocks?: Block[]; media?: Media[] }
export interface Subset { id: number; name: string; parent_id: number | null; sort_order: number }
export interface Knowledge { id: number; subject_id: string; code: string; display_name: string; parent_id: number | null }
export interface Question { id: number; question_id?: number; bank_id: number; stem: string | null; analysis?: string | null; sourceText?: string | null; draftAnswerPayload?: Record<string, unknown> | null; answerPayload?: Record<string, unknown> | null; missingFields: string[]; answer_mode: Mode | null; choice_variant: 'single' | 'multiple' | null; matching_variant?: 'one_to_one' | 'many_to_one' | null; blank_count?: number; question_type_id: string | null; status: string; question_status?: string; group_id: number | null; subset_id: number | null; options: Option[]; items?: Item[]; answer_keys?: Key[]; content_blocks?: Block[]; media?: Media[]; knowledge_points?: Knowledge[]; group?: Group; result?: AnswerResult | null }
export interface Session { id: number; bank_id: number; mode: string; status: string; question_count: number; answered_count: number; correct_count: number | null; score: number | null }
export interface AnswerResult { answer_payload: Record<string, unknown>; is_correct: boolean | null; answer_key_payload: Record<string, unknown> | null; explanation_payload: Record<string, unknown> | null; score: number | null }
export interface QuestionPage { session: Session; question: Question; questionIndex: number; total: number; result: AnswerResult | null; progress: { index: number; isAnswered: boolean; isCorrect: boolean | null }[]; nextIndex: number | null; previousIndex: number | null }
export interface Snapshot { summary: { attempts: number; correct: number; wrong: number; accuracy: number; banks: number; favorite_banks: number }; recentSessions: Session[]; weakQuestions: { question_id: number; bank_id: number; stem: string; wrong_count: number }[]; trend: { day: string; attempts: number; correct: number }[] }
export interface Task { id: number; source_question_id?: number | null; kind: string; status: string; attempt: number; result: { description?: string; tags?: string[]; summary?: string; canonicalAnswer?: string | null; explanation?: string | null; missingFields?: string[]; answerPayload?: Record<string, unknown> | null; recommendations?: string[]; steps?: string[] } | null; error: { code: string; message: string } | null; usage?: { attempt: number; usage: Record<string, unknown> }[] }
export interface ImportJob { id: number; bank_id: number; file_name: string; source_type: string; status: string; ai_task_id: number | null; source_deleted_at: string | null; task?: Task; retry_count: number }
export interface QuestionType { type_id: string; subject_id: string; display_name: string; default_answer_mode: Mode }

const pending = new Map<string, string>();
export async function request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; key?: string } = {}): Promise<Envelope<T>> {
  const method = options.method ?? 'GET';
  const form = options.body instanceof FormData;
  const body = form ? options.body as FormData : options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = {};
  if (body && !form) headers['Content-Type'] = 'application/json';
  let identity = typeof body === 'string' ? body : '';
  if (form) {
    const parts: string[] = [];
    for (const [name, value] of (body as FormData).entries()) parts.push(typeof value === 'string' ? JSON.stringify([name, value]) : JSON.stringify([name, value.name, value.type, await fileDigest(value)]));
    identity = JSON.stringify(parts);
  }
  const signature = `${method}:${path}:${identity}`;
  if (method !== 'GET') {
    // Retain a failed mutation's identity until a confirmed response or explicit retry succeeds.
    const key = options.key ?? pending.get(signature) ?? crypto.randomUUID();
    headers['Idempotency-Key'] = key;
    pending.set(signature, key);
  }
  const response = await fetch(`/api/v1${path}`, { method, body, headers, signal: options.signal, credentials: 'same-origin' });
  const value = response.status === 204 ? { data: null } : await response.json();
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && ![409, 429].includes(response.status)) pending.delete(signature);
    throw new ApiError(response.status, value.error?.code ?? 'REQUEST_FAILED', value.error?.message ?? '请求失败');
  }
  pending.delete(signature);
  return value as Envelope<T>;
}
export const get = <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal });
export const mutate = async <T>(path: string, method = 'POST', body?: unknown, key?: string) => (await request<T>(path, { method, body, key })).data;
export async function fileDigest(file: File) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
}
export function clearClientCache() { pending.clear(); localStorage.removeItem('practiq-import'); }
export function answerPayload(mode: Mode | null, value: string, selected: string[]): Record<string, unknown> {
  if (mode === 'choice') return { selected };
  if (mode === 'true_false') return { value: value === 'true' };
  if (mode === 'fill_blank') return { value: value.split('\n') };
  return { value };
}
