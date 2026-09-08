import type { ApiClient, ApiRequestOptions } from "./client";
import { ApiClientError } from "./client";
import type { ApiEnvelope, Pagination, User } from "./contracts";

export interface PageResult<T> { items: T[]; pagination: Pagination }
export interface CapabilitySet { wechatPay: boolean; ai: boolean; uploads: boolean }
export interface Subject { subject_id: string; display_name: string }
export interface QuestionType { type_id: string; subject_id: string; display_name: string; default_answer_mode: AnswerMode }
export type AnswerMode = "choice" | "true_false" | "fill_blank" | "short_answer";
export interface BankRecord { id: number; subject_id: string; name: string; description: string | null; status: "private" | "public" | "banned"; is_owner: boolean; is_favorite: boolean; created_at?: string; updated_at?: string }
export interface BankItem { question_id: number; question_type_id: string; answer_mode: AnswerMode; choice_variant?: "single" | "multiple" | null; stem: string; analysis?: string | null; question_status: string; options?: QuestionOption[] }
export interface QuestionOption { id?: number; option_label: string; content: string; sort_order?: number; is_correct?: boolean | null }
export interface QuestionRecord { id: number; question_id?: number; subject_id: string; question_type_id: string; answer_mode: AnswerMode; choice_variant?: string | null; stem: string; analysis?: string | null; status: string; question_status?: string; can_edit?: boolean; options: QuestionOption[]; answer_keys?: unknown[]; content_blocks?: ContentBlock[] }
export interface ContentBlock { part_type: string; sequence: number; payload: Record<string, unknown> }
export interface Subset { id: number; bank_id: number; parent_id: number | null; name: string; sort_order: number }
export interface PracticeSession { id: number; bank_id: number; session_type?: string; mode?: string; status: string; question_count?: number; answered_count?: number; current_index?: number; started_at?: string; completed_at?: string | null }
export interface PracticeQuestionPage { session: PracticeSession; question: QuestionRecord; questionIndex: number; total: number; answeredCount: number; result?: Record<string, unknown> | null; previousIndex?: number | null; nextIndex?: number | null }
export interface ImportJob { id: number; bank_id: number; status: string; source_file_name?: string | null; source_size_bytes?: number | null; retry_count?: number; retry_expires_at?: string | null; created_at?: string; completed_at?: string | null; [key: string]: unknown }
export interface AiTask { id: number; kind: "import" | "answer_generation" | "learning_report"; status: string; result?: unknown; error?: unknown; created_at?: string; updated_at?: string }
export interface StudyGroup { id: number; name: string; description?: string | null; owner_user_id?: number; role?: "owner" | "member"; member_count?: number; bank_count?: number }
export interface GroupMember { user_id: number; display_name?: string | null; avatar_url?: string | null; status: string; joined_at?: string }
export interface AdminUser extends User { createdAt?: string }
export interface KnowledgePoint { id: number; subject_id: string; code: string; display_name: string; parent_id: number | null }
export interface PaymentOrder { id: number; kind: "pro" | "credits"; status: string; amountCents: number; currency: string; creditsAmount?: number | string; expiresAt: string }
export interface WechatPaymentParameters { timeStamp: string; nonceStr: string; package: string; signType: "MD5" | "HMAC-SHA256" | "RSA"; paySign: string }
export interface PaymentIntent { order: PaymentOrder; requestPayment?: WechatPaymentParameters }
export interface MediaAsset { id: number; mime_type: string; original_name: string; size_bytes: number }

const query = (values: Record<string, string | number | boolean | null | undefined>): string => {
  const result = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "").map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&");
  return result ? `?${result}` : "";
};

const page = async <T>(client: ApiClient, path: string): Promise<PageResult<T>> => {
  const envelope = await client.requestEnvelope<T[]>(path);
  const pagination = envelope.meta?.pagination;
  if (!pagination) throw new ApiClientError(0, "INVALID_RESPONSE", "分页响应缺少 pagination");
  return { items: envelope.data, pagination };
};

const mutation = (method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown, idempotent = false): ApiRequestOptions => ({
  method,
  body,
  headers: idempotent ? { "Idempotency-Key": `${Date.now()}-${Math.random().toString(36).slice(2)}` } : undefined,
});

export function createApi(client: ApiClient) {
  return {
    capabilities: () => client.request<CapabilitySet>("/api/v1/capabilities"),
    auth: {
      me: () => client.getCurrentUser(),
      updateProfile: (body: { displayName?: string; avatarUrl?: string }) => client.request<User>("/api/v1/users/me", mutation("PATCH", body)),
    },
    references: {
      subjects: () => client.request<Subject[]>("/api/v1/subjects"),
      questionTypes: (subject: string) => client.request<QuestionType[]>(`/api/v1/question-types${query({ subject })}`),
      knowledge: (values: { subject?: string; parentId?: number; q?: string; cursor?: string; limit?: number }) => page<KnowledgePoint>(client, `/api/v1/knowledge-points${query(values)}`),
    },
    banks: {
      list: (values: { scope?: string; subject?: string; q?: string; cursor?: string; limit?: number }) => page<BankRecord>(client, `/api/v1/banks${query(values)}`),
      get: (id: number) => client.request<BankRecord>(`/api/v1/banks/${id}`),
      create: (body: unknown) => client.request<BankRecord>("/api/v1/banks", mutation("POST", body, true)),
      update: (id: number, body: unknown) => client.request<BankRecord>(`/api/v1/banks/${id}`, mutation("PATCH", body)),
      remove: (id: number) => client.request<void>(`/api/v1/banks/${id}`, mutation("DELETE")),
      favorite: (id: number, active: boolean) => client.request<void>(`/api/v1/banks/${id}/favorite`, mutation(active ? "POST" : "DELETE")),
      clone: (id: number) => client.request<BankRecord>(`/api/v1/banks/${id}/clone`, mutation("POST", undefined, true)),
      items: (id: number, values: { status?: string; type?: string; cursor?: string; limit?: number; includeAnswers?: boolean } = {}) => page<BankItem>(client, `/api/v1/banks/${id}/items${query(values)}`),
      tags: (id: number) => client.request<string[]>(`/api/v1/banks/${id}/tags`),
      replaceTags: (id: number, tags: string[]) => client.request<string[]>(`/api/v1/banks/${id}/tags`, { method: "PATCH", body: { tags } }),
      subsets: (id: number) => client.request<Subset[]>(`/api/v1/banks/${id}/subsets`),
      createSubset: (id: number, body: unknown) => client.request<Subset>(`/api/v1/banks/${id}/subsets`, mutation("POST", body)),
      updateSubset: (bankId: number, subsetId: number, body: unknown) => client.request<Subset>(`/api/v1/banks/${bankId}/subsets/${subsetId}`, mutation("PATCH", body)),
      removeSubset: (bankId: number, subsetId: number) => client.request<void>(`/api/v1/banks/${bankId}/subsets/${subsetId}`, mutation("DELETE")),
      resetPractice: (id: number) => client.request<void>(`/api/v1/banks/${id}/practice-data`, mutation("DELETE")),
    },
    questions: {
      get: (id: number) => client.request<QuestionRecord>(`/api/v1/questions/${id}`),
      create: (bankId: number, body: unknown) => client.request<QuestionRecord>(`/api/v1/banks/${bankId}/questions`, mutation("POST", body, true)),
      update: (id: number, body: unknown) => client.request<QuestionRecord>(`/api/v1/questions/${id}`, mutation("PATCH", body)),
      remove: (id: number) => client.request<void>(`/api/v1/questions/${id}`, mutation("DELETE")),
      publish: (id: number) => client.request<QuestionRecord>(`/api/v1/questions/${id}/publish`, mutation("POST")),
      archive: (id: number) => client.request<QuestionRecord>(`/api/v1/questions/${id}/archive`, mutation("POST")),
      answerKey: (id: number, body: unknown) => client.request<unknown>(`/api/v1/questions/${id}/answer-key`, mutation("PUT", body)),
      aiAnswer: (id: number) => client.request<AiTask>(`/api/v1/questions/${id}/ai-answer-tasks`, mutation("POST", undefined, true)),
      contentBlocks: (id: number, blocks: ContentBlock[]) => client.request<void>(`/api/v1/questions/${id}/content-blocks`, mutation("PUT", { blocks })),
    },
    media: {
      upload: (filePath: string) => upload<MediaAsset>(client, "/api/v1/media", filePath, "file"),
      linkQuestion: (questionId: number, mediaId: number, mediaKind: string, sortOrder = 1) => client.request<unknown>(`/api/v1/questions/${questionId}/media-links`, mutation("POST", { mediaId, mediaKind, sortOrder })),
      remove: (id: number) => client.request<void>(`/api/v1/media/${id}`, mutation("DELETE")),
    },
    practice: {
      start: (body: unknown) => client.request<PracticeSession>("/api/v1/practice-sessions", mutation("POST", body, true)),
      get: (id: number) => client.request<PracticeSession>(`/api/v1/practice-sessions/${id}`),
      page: (id: number, index: number) => client.request<PracticeQuestionPage>(`/api/v1/practice-sessions/${id}/question-page${query({ index })}`),
      answer: (id: number, body: unknown) => client.request<unknown>(`/api/v1/practice-sessions/${id}/answers`, mutation("POST", body, true)),
      complete: (id: number) => client.request<PracticeSession>(`/api/v1/practice-sessions/${id}/complete`, mutation("POST")),
      abandon: (id: number) => client.request<PracticeSession>(`/api/v1/practice-sessions/${id}/abandon`, mutation("POST")),
      results: (id: number) => client.request<unknown>(`/api/v1/practice-sessions/${id}/results`),
    },
    imports: {
      list: (values: { status?: string; cursor?: string; limit?: number }) => page<ImportJob>(client, `/api/v1/import-jobs${query(values)}`),
      create: (body: unknown) => client.request<ImportJob>("/api/v1/import-jobs", mutation("POST", body, true)),
      get: (id: number) => client.request<ImportJob>(`/api/v1/import-jobs/${id}`),
      action: (id: number, action: "parse" | "retry" | "cancel", body?: unknown) => client.request<ImportJob>(`/api/v1/import-jobs/${id}/${action}`, mutation("POST", body)),
      children: (id: number, kind: "events" | "outputs") => client.request<unknown[]>(`/api/v1/import-jobs/${id}/${kind}`),
      upload: async (id: number, filePath: string): Promise<ImportJob> => upload<ImportJob>(client, `/api/v1/import-jobs/${id}/file`, filePath, "file"),
    },
    analytics: {
      snapshot: () => client.getAnalyticsSnapshot(),
      bank: (id: number) => client.request<Record<string, unknown>>(`/api/v1/analytics/banks/${id}`),
      leaderboard: (id: number) => client.request<Record<string, unknown>[]>(`/api/v1/analytics/banks/${id}/leaderboard`),
      report: (body: unknown) => client.request<AiTask>("/api/v1/analytics/report-tasks", mutation("POST", body, true)),
    },
    search: {
      questions: (values: { bankId?: number; type?: string; status?: string; q?: string; cursor?: string; limit?: number }) => page<QuestionRecord>(client, `/api/v1/search/questions${query(values)}`),
    },
    aiTasks: {
      get: (id: number) => client.request<AiTask>(`/api/v1/ai-tasks/${id}`),
      cancel: (id: number) => client.request<AiTask>(`/api/v1/ai-tasks/${id}/cancel`, mutation("POST")),
    },
    payments: {
      create: (kind: "pro" | "credits") => client.request<PaymentIntent>("/api/v1/payment-orders", { method: "POST", body: { kind }, headers: { "Idempotency-Key": `${kind}-${Date.now()}` } }),
      get: (id: number) => client.request<PaymentIntent>(`/api/v1/payment-orders/${id}`),
      adminList: () => client.request<PaymentOrder[]>("/api/v1/admin/payment-orders"),
      refund: (id: number) => client.request<unknown>(`/api/v1/admin/payment-orders/${id}/refund`, mutation("POST", undefined, true)),
    },
    groups: {
      list: () => client.request<StudyGroup[]>("/api/v1/study-groups"),
      create: (body: unknown) => client.request<StudyGroup>("/api/v1/study-groups", mutation("POST", body, true)),
      get: (id: number) => client.request<StudyGroup>(`/api/v1/study-groups/${id}`),
      update: (id: number, body: unknown) => client.request<StudyGroup>(`/api/v1/study-groups/${id}`, mutation("PATCH", body)),
      remove: (id: number) => client.request<void>(`/api/v1/study-groups/${id}`, mutation("DELETE")),
      members: (id: number) => client.request<GroupMember[]>(`/api/v1/study-groups/${id}/members`),
      invite: (id: number) => client.request<{ token: string; expiresAt: string }>(`/api/v1/study-groups/${id}/invitations`, mutation("POST", undefined, true)),
      inviteInfo: (token: string) => client.request<StudyGroup>(`/api/v1/study-group-invitations/${encodeURIComponent(token)}`),
      respond: (token: string, action: "accept" | "reject") => client.request<StudyGroup>(`/api/v1/study-group-invitations/${encodeURIComponent(token)}/${action}`, mutation("POST")),
      leave: (id: number) => client.request<void>(`/api/v1/study-groups/${id}/leave`, mutation("POST")),
      removeMember: (id: number, userId: number) => client.request<void>(`/api/v1/study-groups/${id}/members/${userId}`, mutation("DELETE")),
      linkBank: (id: number, bankId: number, active: boolean) => client.request<void>(`/api/v1/study-groups/${id}/banks/${bankId}`, mutation(active ? "POST" : "DELETE")),
      memberAnalytics: (id: number, userId: number) => client.request<Record<string, unknown>>(`/api/v1/study-groups/${id}/members/${userId}/analytics`),
    },
    admin: {
      users: (values: { q?: string; status?: string; role?: string; cursor?: string; limit?: number }) => page<AdminUser>(client, `/api/v1/admin/users${query(values)}`),
      updateUser: (id: number, body: unknown) => client.request<AdminUser>(`/api/v1/admin/users/${id}`, mutation("PATCH", body)),
      banBank: (id: number, active: boolean) => client.request<BankRecord>(`/api/v1/admin/banks/${id}/${active ? "ban" : "unban"}`, mutation("POST")),
      knowledgeCreate: (body: unknown) => client.request<KnowledgePoint>("/api/v1/admin/knowledge-points", mutation("POST", body)),
      knowledgeUpdate: (id: number, body: unknown) => client.request<KnowledgePoint>(`/api/v1/admin/knowledge-points/${id}`, mutation("PATCH", body)),
      knowledgeDelete: (id: number) => client.request<void>(`/api/v1/admin/knowledge-points/${id}`, mutation("DELETE")),
      knowledgeImport: (filePath: string) => upload<{ imported: number }>(client, "/api/v1/admin/knowledge-points/import", filePath, "file"),
    },
  };
}

async function upload<T>(client: ApiClient, path: string, filePath: string, name: string): Promise<T> {
  const { default: Taro } = await import("@tarojs/taro");
  const token = await client.accessToken();
  const base = __PRACTIQ_API_URL__.trim().replace(/\/$/, "");
  const response = await Taro.uploadFile({ url: `${base}${path}`, filePath, name, header: { Authorization: `Bearer ${token}`, Accept: "application/json" }, timeout: 60_000 });
  let parsed: ApiEnvelope<T> | { error?: { code?: string; message?: string; details?: unknown; requestId?: string } };
  try { parsed = JSON.parse(response.data) as typeof parsed; } catch { throw new ApiClientError(response.statusCode, "INVALID_RESPONSE", "上传响应格式不正确"); }
  if (response.statusCode < 200 || response.statusCode >= 300 || !("data" in parsed)) {
    const error = "error" in parsed ? parsed.error : undefined;
    throw new ApiClientError(response.statusCode, error?.code ?? "UPLOAD_FAILED", error?.message ?? "文件上传失败", error?.details, error?.requestId);
  }
  return parsed.data;
}

declare const __PRACTIQ_API_URL__: string;
