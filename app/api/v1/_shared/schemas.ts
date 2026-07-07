import { z } from 'zod';

export const bankSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  subject: z.string().min(1).max(32),
  isPublic: z.boolean().optional()
});

export const bankUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  isPublic: z.boolean().optional()
});

export const bankItemsReorderSchema = z.object({
  items: z.array(z.object({
    questionId: z.number().int().positive().optional(),
    groupId: z.number().int().positive().optional(),
    sortOrder: z.number().int().positive()
  }))
});

export const groupSchema = z.object({
  title: z.string().min(1),
  instructions: z.string().optional().nullable(),
  groupTypeId: z.string().optional().nullable(),
  contentMode: z.enum(['text_only', 'mixed_media', 'structured_rich']).optional().nullable(),
  status: z.enum(['draft', 'active', 'archived']).optional()
});

export const addGroupQuestionSchema = z.object({
  questionId: z.number().int().positive(),
  sortOrder: z.number().int().positive().optional()
});

export const reorderGroupQuestionsSchema = z.object({
  items: z.array(z.object({
    questionId: z.number().int().positive(),
    sortOrder: z.number().int().positive()
  }))
});

export const questionSchema = z.object({
  questionTypeId: z.string().min(1),
  answerMode: z.enum(['choice', 'true_false', 'fill_blank', 'short_answer']),
  stem: z.string().min(1),
  analysis: z.string().optional().nullable(),
  choiceVariant: z.enum(['single', 'multiple']).optional().nullable(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  options: z.array(z.object({
    label: z.string().min(1).max(16),
    content: z.string().min(1),
    isCorrect: z.boolean().optional()
  })).optional(),
  answerPayload: z.record(z.unknown()).optional()
});

export const questionUpdateSchema = z.object({
  stem: z.string().min(1).optional(),
  analysis: z.string().optional().nullable(),
  status: z.enum(['draft', 'active', 'archived']).optional()
});

export const generateQuestionAnswerSchema = z.object({
  apply: z.boolean().optional()
});

export const answerKeySchema = z.object({
  answerMode: z.enum(['choice', 'true_false', 'fill_blank', 'short_answer']),
  answerPayload: z.record(z.unknown()),
  explanationPayload: z.record(z.unknown()).optional(),
  scorePayload: z.record(z.unknown()).optional()
});

export const optionSchema = z.object({
  label: z.string().min(1).max(16),
  content: z.string().min(1),
  isCorrect: z.boolean().optional(),
  sortOrder: z.number().int().positive().optional()
});

export const mediaLinkSchema = z.object({
  mediaId: z.number().int().positive(),
  mediaKind: z.string().min(1),
  sortOrder: z.number().int().positive().optional()
});

export const metadataSchema = z.object({
  difficultyLevel: z.string().optional().nullable(),
  difficultyScore: z.number().min(0).max(100).optional().nullable(),
  gradeLevel: z.string().optional().nullable(),
  examType: z.string().optional().nullable(),
  curriculumStandard: z.string().optional().nullable(),
  textbookVersion: z.string().optional().nullable(),
  knowledgeTags: z.array(z.string()).optional(),
  skillTags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional()
});

export const knowledgePointsSchema = z.object({
  knowledgePointIds: z.array(z.number().int().positive())
});

export const contentBlocksSchema = z.object({
  blocks: z.array(z.object({
    ownerKind: z.string().optional(),
    role: z.string().optional().nullable(),
    partType: z.enum(['text', 'formula', 'image', 'table', 'list', 'html', 'markdown', 'chart', 'diagram', 'qr_code']),
    sequence: z.number().int().positive().optional(),
    contentMode: z.string().optional().nullable(),
    textFormat: z.string().optional().nullable(),
    textValue: z.string().optional().nullable(),
    latexValue: z.string().optional().nullable(),
    mathmlValue: z.string().optional().nullable(),
    htmlValue: z.string().optional().nullable(),
    markdownValue: z.string().optional().nullable(),
    jsonValue: z.union([z.record(z.unknown()), z.string()]).optional().nullable(),
    mediaId: z.number().int().positive().optional().nullable()
  }))
});

export const practiceStartSchema = z.object({
  bankId: z.number().int().positive(),
  sessionType: z.enum(['practice', 'review', 'exam']).optional(),
  questionCount: z.number().int().positive().max(500).optional(),
  mode: z.enum(['all', 'wrong', 'by_type', 'exam']).optional(),
  questionTypeId: z.string().min(1).max(64).optional().nullable(),
  allQuestions: z.boolean().optional()
});

export const answerSchema = z.object({
  questionId: z.number().int().positive(),
  answerPayload: z.record(z.unknown()),
  durationMs: z.number().int().nonnegative().optional()
});

export const importJobSchema = z.object({
  bankId: z.number().int().positive().optional().nullable(),
  fileName: z.string().optional().nullable(),
  sourceType: z.enum(['txt', 'text', 'docx']).optional().nullable(),
  requestPayload: z.record(z.unknown()).optional()
});

export const importJobFileSchema = z.object({
  artifactType: z.string().optional(),
  storagePath: z.string().optional().nullable(),
  content: z.record(z.unknown()).optional().nullable(),
  sourceType: z.enum(['txt', 'text', 'docx']).optional().nullable()
});

export const importJobParseSchema = z.object({
  persistQuestions: z.boolean().optional()
});

export const importReviewResolveSchema = z.object({
  note: z.string().optional().nullable()
});

export const mediaSchema = z.object({
  storagePath: z.string().min(1),
  externalUrl: z.string().url().optional().nullable(),
  originalName: z.string().optional().nullable(),
  mimeType: z.string().optional().nullable(),
  sizeBytes: z.number().int().nonnegative().optional().nullable()
});

export const profileSchema = z.object({
  username: z.string().trim().min(2).max(32).optional(),
  email: z.string().email().optional().nullable(),
  password: z.string().min(8).max(100).optional(),
  avatarUrl: z.string().trim().min(1).max(1024).optional().nullable()
});

export const userStatusSchema = z.object({
  isActive: z.boolean()
});

export const aiDocumentParseSchema = z.object({
  importJobId: z.number().int().positive().optional().nullable(),
  bankId: z.number().int().positive().optional().nullable(),
  sourceType: z.enum(['docx', 'txt', 'text']).default('txt'),
  fileName: z.string().optional().nullable(),
  text: z.string().optional().nullable(),
  fileBase64: z.string().optional().nullable(),
  mimeType: z.string().optional().nullable()
}).refine((value) => Boolean(value.text?.trim() || value.fileBase64?.trim()), {
  message: 'text or fileBase64 is required',
  path: ['text']
});

export const aiAnswerSchema = z.object({
  questionId: z.number().int().positive().optional().nullable(),
  stem: z.string().min(1),
  answerMode: z.enum(['choice', 'true_false', 'fill_blank', 'short_answer']),
  options: z.array(z.object({ label: z.string(), content: z.string() })).optional(),
  analysis: z.string().optional().nullable()
});

export const aiReportSchema = z.object({
  userId: z.number().int().positive().optional().nullable(),
  bankId: z.number().int().positive().optional().nullable(),
  practiceSessionId: z.number().int().positive().optional().nullable(),
  scope: z.enum(['individual', 'class', 'bank']).default('individual')
});
