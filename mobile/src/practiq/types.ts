import { z } from 'zod';

const id = z.number().int();
const nullableString = z.string().nullable();

export const answerModeSchema = z.enum(['choice', 'true_false', 'fill_blank', 'short_answer']);
export const choiceVariantSchema = z.enum(['single', 'multiple']).nullable();

export const cloudUserSchema = z.object({
  id,
  username: z.string().min(1),
  email: z.string().email().nullable(),
  is_active: z.boolean(),
  role: z.enum(['admin', 'user']),
  membership: z.enum(['free', 'pro']),
  revenuecat_app_user_id: z.uuid(),
}).loose();
export type CloudUser = z.infer<typeof cloudUserSchema>;

export const llmProviderSchema = z.enum([
  'anthropic', 'dashscope', 'deepseek', 'gemini', 'moonshot', 'openai', 'xai',
]);
export const llmConfigSchema = z.object({
  provider: llmProviderSchema.nullable(),
  textModel: z.string().nullable(),
  visionModel: z.string().nullable(),
  configured: z.boolean(),
});
export type LLMProvider = z.infer<typeof llmProviderSchema>;
export type LLMConfig = z.infer<typeof llmConfigSchema>;

export const bankSchema = z.object({
  id,
  name: z.string(),
  description: nullableString,
  subject: z.string(),
  total_count: z.number().int().nonnegative(),
  is_public: z.boolean(),
  is_owner: z.boolean().optional(),
  is_favorite: z.boolean().optional(),
  pending: z.boolean().optional(),
  // 镜像层需要的交付字段(服务端实际返回,声明以获得类型)
  created_by: id.nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).loose();
export const banksSchema = z.array(bankSchema);
export type Bank = z.infer<typeof bankSchema>;

export const questionOptionSchema = z.object({
  id,
  option_label: z.string(),
  sort_order: z.number().int(),
  content: z.string(),
  is_correct: z.boolean().optional(),
  question_id: id.optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).loose();
export type QuestionOption = z.infer<typeof questionOptionSchema>;

export const bankItemSchema = z.object({
  question_id: id,
  group_id: id.nullable(),
  stem: z.string(),
  analysis: nullableString.optional(),
  answer_mode: answerModeSchema,
  choice_variant: choiceVariantSchema,
  question_type_id: z.string(),
  question_status: z.enum(['draft', 'active', 'archived']),
  bank_link_status: z.enum(['draft', 'active', 'archived']),
  group_title: nullableString.optional(),
  group_instructions: nullableString.optional(),
  options: z.array(questionOptionSchema).optional(),
  // 镜像层需要的交付字段(服务端实际返回,声明以获得类型)
  bank_id: id.optional(),
  item_scope: z.string().optional(),
  bank_sort_order: z.number().int().optional(),
  group_sort_order: z.number().int().nullable().optional(),
  question_no: nullableString.optional(),
  business_type: z.string().optional(),
  subject_id: z.string().optional(),
  content_mode: z.string().nullable().optional(),
}).loose();
export const bankItemsSchema = z.array(bankItemSchema);
export type BankItem = z.infer<typeof bankItemSchema>;

export const bankGroupSchema = z.object({
  id,
  group_type_id: z.string(),
  title: nullableString,
  instructions: nullableString,
  content_mode: z.enum(['text_only', 'mixed_media', 'structured_rich']).nullable(),
  status: z.enum(['draft', 'active', 'archived']),
  sort_order: z.number().int().positive(),
  question_count: z.number().int().nonnegative(),
  can_edit: z.boolean(),
}).loose();
export const bankGroupsSchema = z.array(bankGroupSchema);
export type BankGroup = z.infer<typeof bankGroupSchema>;

export const questionDetailSchema = z.object({
  id,
  stem: z.string(),
  analysis: nullableString.optional(),
  answer_mode: answerModeSchema,
  question_type_id: z.string(),
  status: z.enum(['draft', 'active', 'archived']),
  options: z.array(questionOptionSchema),
  answer_keys: z.array(z.object({
    answer_payload: z.string(),
    id: id.optional(),
    question_id: id.optional(),
    answer_mode: answerModeSchema.optional(),
    version: z.number().int().optional(),
    is_primary: z.boolean().optional(),
    explanation_payload: z.string().optional(),
    score_payload: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  }).loose()).optional(),
  media_links: z.array(z.object({
    id,
    media_id: id,
    media_kind: z.string(),
    sort_order: z.number().int(),
    question_id: id.optional(),
    created_at: z.string().optional(),
  }).loose()),
  can_edit: z.boolean(),
  // 镜像层需要的交付字段(服务端实际返回,声明以获得类型)
  business_type: z.string().optional(),
  subject_id: z.string().optional(),
  choice_variant: choiceVariantSchema.optional(),
  content_mode: z.string().nullable().optional(),
  detail_payload: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).loose();
export type QuestionDetail = z.infer<typeof questionDetailSchema>;

export const mediaAssetSchema = z.object({
  id,
  content_url: z.string(),
  original_name: nullableString,
  mime_type: nullableString,
  size_bytes: z.number().int().nonnegative().nullable(),
  // 镜像层需要的交付字段(服务端实际返回,声明以获得类型)
  created_by: id.nullable().optional(),
  external_url: nullableString.optional(),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  duration_ms: z.number().int().nullable().optional(),
  created_at: z.string().optional(),
}).loose();
export type MediaAsset = z.infer<typeof mediaAssetSchema>;

export const practiceSessionSchema = z.object({
  id,
  bank_id: id.nullable(),
  session_type: z.string(),
  status: z.enum(['active', 'completed', 'abandoned']),
  question_count: z.number().int().nonnegative(),
  answered_count: z.number().int().nonnegative(),
  correct_count: z.number().int().nonnegative(),
  wrong_count: z.number().int().nonnegative(),
  score: z.number().nullable(),
  // 镜像层需要的交付字段(服务端实际返回,声明以获得类型)
  user_id: id.optional(),
  started_at: z.string().optional(),
  completed_at: nullableString.optional(),
}).loose();
export const practiceSessionsSchema = z.array(practiceSessionSchema);
export type PracticeSession = z.infer<typeof practiceSessionSchema>;

export const practiceAnswerSchema = z.object({
  id,
  question_id: id,
  answer_payload: z.record(z.string(), z.unknown()),
  is_correct: z.boolean().nullable(),
  score: z.number().nullable(),
  max_score: z.number().nullable(),
}).loose();

export const practicePageSchema = z.object({
  session: practiceSessionSchema,
  question: bankItemSchema.nullable(),
  questionIndex: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  answeredCount: z.number().int().nonnegative(),
  progress: z.array(z.object({
    index: z.number().int().nonnegative(),
    questionId: id,
    isAnswered: z.boolean(),
    isCorrect: z.boolean().nullable(),
  })),
  result: practiceAnswerSchema.nullable(),
  previousIndex: z.number().int().nonnegative().nullable(),
  nextIndex: z.number().int().nonnegative().nullable(),
}).loose();
export type PracticePage = z.infer<typeof practicePageSchema>;

export const practiceResultSchema = practiceAnswerSchema.safeExtend({
  stem: z.string(),
  analysis: nullableString,
  answer_mode: answerModeSchema,
});
export const practiceResultsSchema = z.array(practiceResultSchema);
export type PracticeResult = z.infer<typeof practiceResultSchema>;

export const importJobSchema = z.object({
  id,
  bank_id: id.nullable(),
  status: z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']),
  stage: z.string(),
  file_name: nullableString,
  imported_questions: z.number().int().nonnegative(),
  total_questions: z.number().int().nonnegative(),
  overall_progress_percent: z.number().nullable(),
  last_error: nullableString,
}).loose();
export const importJobsSchema = z.array(importJobSchema);
export type ImportJob = z.infer<typeof importJobSchema>;

export const importEventSchema = z.object({
  id,
  status: z.string(),
  message: z.string().nullable().optional(),
}).loose();
export const importEventsSchema = z.array(importEventSchema);
export type ImportEvent = z.infer<typeof importEventSchema>;

export const importOutputSchema = z.object({
  id,
  question_id: id,
}).loose();
export const importOutputsSchema = z.array(importOutputSchema);
export type ImportOutput = z.infer<typeof importOutputSchema>;

export const analyticsSummarySchema = z.object({
  owned_banks: z.number().int().nonnegative(),
  favorite_banks: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  correct: z.number().int().nonnegative(),
  wrong: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  active_sessions: z.number().int().nonnegative(),
  active_imports: z.number().int().nonnegative(),
  accuracy: z.number().min(0).max(100),
}).loose();
export type AnalyticsSummary = z.infer<typeof analyticsSummarySchema>;

export const analyticsSnapshotSchema = z.object({
  summary: analyticsSummarySchema,
  recentSessions: z.array(practiceSessionSchema),
  weakQuestions: z.array(z.object({
    question_id: id,
    stem: z.string(),
    wrong_count: z.number().int().nonnegative(),
  }).loose()),
}).loose();
export type AnalyticsSnapshot = z.infer<typeof analyticsSnapshotSchema>;

export const searchQuestionSchema = z.object({
  id,
  stem: z.string(),
  analysis: nullableString,
  answer_mode: answerModeSchema,
  choice_variant: choiceVariantSchema,
  question_type_id: z.string(),
  status: z.enum(['draft', 'active', 'archived']),
  can_edit: z.boolean(),
}).loose();
export const searchQuestionsSchema = z.array(searchQuestionSchema);
export type SearchQuestion = z.infer<typeof searchQuestionSchema>;

export const subjectSchema = z.object({
  subject_id: z.string(),
  display_name: z.string(),
}).loose();
export const subjectsSchema = z.array(subjectSchema);

export const questionTypeSchema = z.object({
  type_id: z.string(),
  subject_id: z.string(),
  display_name: z.string(),
  scope: z.string(),
  default_answer_mode: answerModeSchema.nullable(),
}).loose();
export const questionTypesSchema = z.array(questionTypeSchema);
export type QuestionType = z.infer<typeof questionTypeSchema>;
