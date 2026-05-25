import { z } from 'zod';
import { hashPassword, requireUser } from '@/lib/openwook/auth';
import { ApiError, created, handleApiError, noContent, ok, parseId, readJson } from '@/lib/openwook/api';
import { streamImportEvents, type ImportEventPayload } from '@/lib/openwook/import-events';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import {
  addImportJobFile,
  addImportJobUploadedFile,
  addQuestionToGroup,
  completePracticeSession,
  createBank,
  createGroup,
  createImportJob,
  createKnowledgePoint,
  createMediaAsset,
  createOption,
  createQuestion,
  deleteBank,
  deleteMediaAsset,
  deleteQuestion,
  getAnalyticsSummary,
  getBankLeaderboard,
  getBankAnalytics,
  getBank,
  getImportAnalytics,
  getImportJob,
  getMediaAsset,
  exportUserSummaryPdf,
  getUserStatsSnapshot,
  getPracticeQuestionPage,
  getPracticeQuestions,
  getPracticeResults,
  getPracticeSession,
  getQuestion,
  getGroup,
  linkGroupMedia,
  linkOptionMedia,
  linkQuestionMedia,
  listBankItems,
  listBanks,
  listImportJobChildren,
  listImportJobs,
  listKnowledgePoints,
  listPracticeSessions,
  listQuestionTypes,
  listSubjects,
  queueImportJobForUser,
  reorderBankItems,
  replaceQuestionContentBlocks,
  replaceQuestionKnowledgePoints,
  removeQuestionFromGroup,
  resolveImportReviewItem,
  reorderGroupQuestions,
  search,
  setFavorite,
  setQuestionStatus,
  setUserStatus,
  startPracticeSession,
  submitAnswer,
  updateBank,
  updateCurrentUser,
  updateGroup,
  updateImportJobStatus,
  updateKnowledgePoint,
  updateOption,
  updateQuestion,
  upsertAnswerKey,
  upsertQuestionMetadata
} from '@/lib/openwook/services';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ path?: string[] }> };
type ImportChildKind = 'events' | 'pages' | 'blocks' | 'review-items' | 'outputs' | 'artifacts';

const bankSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  subject: z.string().min(1).max(32),
  isPublic: z.boolean().optional()
});

const knowledgePointSchema = z.object({
  subjectId: z.string().min(1).max(32),
  code: z.string().min(1).max(128),
  displayName: z.string().min(1).max(256),
  parentId: z.number().int().positive().optional().nullable(),
  metadata: z.record(z.unknown()).optional()
});

const groupSchema = z.object({
  title: z.string().min(1),
  instructions: z.string().optional().nullable(),
  groupTypeId: z.string().optional().nullable(),
  contentMode: z.enum(['text_only', 'mixed_media', 'structured_rich']).optional().nullable(),
  status: z.enum(['draft', 'active', 'archived']).optional()
});

const questionSchema = z.object({
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

const practiceStartSchema = z.object({
  bankId: z.number().int().positive(),
  sessionType: z.enum(['practice', 'review', 'exam']).optional(),
  questionCount: z.number().int().positive().max(500).optional(),
  mode: z.enum(['all', 'wrong', 'by_type', 'exam']).optional(),
  questionTypeId: z.string().min(1).max(64).optional().nullable(),
  allQuestions: z.boolean().optional()
});

const answerSchema = z.object({
  questionId: z.number().int().positive(),
  answerPayload: z.record(z.unknown()),
  durationMs: z.number().int().nonnegative().optional()
});

const answerKeySchema = z.object({
  answerMode: z.enum(['choice', 'true_false', 'fill_blank', 'short_answer']),
  answerPayload: z.record(z.unknown()),
  explanationPayload: z.record(z.unknown()).optional(),
  scorePayload: z.record(z.unknown()).optional()
});

const optionSchema = z.object({
  label: z.string().min(1).max(16),
  content: z.string().min(1),
  isCorrect: z.boolean().optional(),
  sortOrder: z.number().int().positive().optional()
});

const mediaLinkSchema = z.object({
  mediaId: z.number().int().positive(),
  mediaKind: z.string().min(1),
  sortOrder: z.number().int().positive().optional()
});

const metadataSchema = z.object({
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

const contentBlocksSchema = z.object({
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

const profileSchema = z.object({
  username: z.string().trim().min(2).max(32).optional(),
  email: z.string().email().optional().nullable(),
  password: z.string().min(8).max(100).optional(),
  avatarUrl: z.string().trim().min(1).max(1024).optional().nullable()
});

const aiDocumentParseSchema = z.object({
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

const aiAnswerSchema = z.object({
  questionId: z.number().int().positive().optional().nullable(),
  stem: z.string().min(1),
  answerMode: z.enum(['choice', 'true_false', 'fill_blank', 'short_answer']),
  options: z.array(z.object({ label: z.string(), content: z.string() })).optional(),
  analysis: z.string().optional().nullable()
});

const aiReportSchema = z.object({
  userId: z.number().int().positive().optional().nullable(),
  bankId: z.number().int().positive().optional().nullable(),
  practiceSessionId: z.number().int().positive().optional().nullable(),
  scope: z.enum(['individual', 'class', 'bank']).default('individual')
});

function partsFrom(ctx: Ctx) {
  return ctx.params.then((params) => params.path ?? []);
}

function isImportChildKind(value: string | undefined): value is ImportChildKind {
  return value === 'events' || value === 'pages' || value === 'blocks' || value === 'review-items' || value === 'outputs' || value === 'artifacts';
}

async function aiHandlers() {
  return import('@/lib/openwook/ai');
}

async function objectStorageHandlers() {
  return import('@/lib/openwook/object-storage');
}

export async function GET(request: Request, ctx: Ctx) {
  try {
    const parts = await partsFrom(ctx);
    const url = new URL(request.url);

    if (parts[0] === 'subjects') return ok(await listSubjects());
    if (parts[0] === 'question-types') {
      return ok(await listQuestionTypes(url.searchParams.get('subject') ?? undefined, url.searchParams.get('scope') ?? undefined));
    }
    if (parts[0] === 'knowledge-points') {
      const parentId = url.searchParams.get('parentId');
      return ok(await listKnowledgePoints(url.searchParams.get('subject') ?? undefined, parentId ? Number(parentId) : undefined));
    }

    const user = await requireUser();

    if (parts[0] === 'banks' && parts.length === 1) return ok(await listBanks(user, url.searchParams));
    if (parts[0] === 'banks' && parts[1]) {
      const bankId = parseId(parts[1], 'bankId');
      if (parts.length === 2) return ok(await getBank(user, bankId));
      if (parts[2] === 'items') return ok(await listBankItems(user, bankId, url.searchParams));
    }

    if (parts[0] === 'questions' && parts[1]) return ok(await getQuestion(user, parseId(parts[1], 'questionId')));
    if (parts[0] === 'groups' && parts[1]) return ok(await getGroup(user, parseId(parts[1], 'groupId')));

    if (parts[0] === 'practice-sessions' && parts.length === 1) return ok(await listPracticeSessions(user, url.searchParams));
    if (parts[0] === 'practice-sessions' && parts[1]) {
      const sessionId = parseId(parts[1], 'sessionId');
      if (parts.length === 2) return ok(await getPracticeSession(user, sessionId));
      if (parts[2] === 'question-page') return ok(await getPracticeQuestionPage(user, sessionId, url.searchParams));
      if (parts[2] === 'questions') return ok(await getPracticeQuestions(user, sessionId));
      if (parts[2] === 'results') return ok(await getPracticeResults(user, sessionId));
    }

    if (parts[0] === 'import-jobs' && parts.length === 1) return ok(await listImportJobs(user, url.searchParams));
    if (parts[0] === 'import-jobs' && parts[1]) {
      const jobId = parseId(parts[1], 'jobId');
      if (parts.length === 2) return ok(await getImportJob(user, jobId));
      if (parts[2] === 'events' && parts[3] === 'stream') {
        const events = await listImportJobChildren(user, jobId, 'events') as unknown as ImportEventPayload[];
        return streamImportEvents(jobId, [...events].reverse(), request.signal);
      }
      if (isImportChildKind(parts[2])) {
        return ok(await listImportJobChildren(user, jobId, parts[2]));
      }
    }

    if (parts[0] === 'media' && parts[1]) return ok(await getMediaAsset(user, parseId(parts[1], 'mediaId')));

    if (parts[0] === 'search' && parts[1]) return ok(await search(user, parts[1], url.searchParams));

    if (parts[0] === 'ai' && parts[1] === 'artifacts') {
      const { getAiArtifacts } = await aiHandlers();
      return ok(await getAiArtifacts(user, url.searchParams));
    }
    if (parts.join('/') === 'exports/me/summary.pdf') {
      const pdfBytes = await exportUserSummaryPdf(user);
      return new Response(new Uint8Array(pdfBytes), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="openwook-summary.pdf"',
          'Cache-Control': 'no-store'
        }
      });
    }

    if (parts.join('/') === 'analytics/me/summary') return ok(await getAnalyticsSummary(user));
    if (parts.join('/') === 'analytics/me/snapshot') return ok(await getUserStatsSnapshot(user));
    if (parts[0] === 'analytics' && parts[1] === 'banks' && parts[2] && parts[3] === 'leaderboard') {
      return ok(await getBankLeaderboard(user, parseId(parts[2], 'bankId'), Number(url.searchParams.get('limit') || 20)));
    }
    if (parts[0] === 'analytics' && parts[1] === 'banks' && parts[2]) return ok(await getBankAnalytics(user, parseId(parts[2], 'bankId')));
    if (parts[0] === 'analytics' && parts[1] === 'imports' && parts[2]) return ok(await getImportAnalytics(user, parseId(parts[2], 'jobId')));

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, ctx: Ctx) {
  try {
    const parts = await partsFrom(ctx);

    assertSameOriginRequest(request);

    const user = await requireUser();

    if (parts[0] === 'knowledge-points' && parts.length === 1) {
      return created(await createKnowledgePoint(user, knowledgePointSchema.parse(await readJson(request))));
    }

    if (parts[0] === 'banks' && parts.length === 1) return created(await createBank(user, bankSchema.parse(await readJson(request))));
    if (parts[0] === 'banks' && parts[1]) {
      const bankId = parseId(parts[1], 'bankId');
      if (parts[2] === 'favorite') {
        await setFavorite(user, bankId, true);
        return noContent();
      }
      if (parts[2] === 'questions') {
        return created(await createQuestion(user, bankId, questionSchema.parse(await readJson(request))));
      }
      if (parts[2] === 'groups') {
        return created(await createGroup(user, bankId, groupSchema.parse(await readJson(request))));
      }
    }

    if (parts[0] === 'questions' && parts[1]) {
      const questionId = parseId(parts[1], 'questionId');
      if (parts[2] === 'publish') return ok(await setQuestionStatus(user, questionId, 'active'));
      if (parts[2] === 'archive') return ok(await setQuestionStatus(user, questionId, 'archived'));
      if (parts[2] === 'generate-answer') {
        const { generateQuestionAnswerWithMastra } = await aiHandlers();
        const body = z.object({ apply: z.boolean().optional() }).parse(await readJson(request));
        return ok(await generateQuestionAnswerWithMastra(user, questionId, { apply: body.apply ?? true }));
      }
      if (parts[2] === 'options') return created(await createOption(user, questionId, optionSchema.parse(await readJson(request))));
      if (parts[2] === 'media-links') {
        return created(await linkQuestionMedia(user, questionId, mediaLinkSchema.parse(await readJson(request))));
      }
    }

    if (parts[0] === 'groups' && parts[1]) {
      const groupId = parseId(parts[1], 'groupId');
      if (parts[2] === 'questions') {
        const body = z.object({
          questionId: z.number().int().positive(),
          sortOrder: z.number().int().positive().optional()
        }).parse(await readJson(request));
        return created(await addQuestionToGroup(user, groupId, body.questionId, body.sortOrder));
      }
      if (parts[2] === 'media-links') {
        return created(await linkGroupMedia(user, groupId, mediaLinkSchema.parse(await readJson(request))));
      }
    }

    if (parts[0] === 'options' && parts[1] && parts[2] === 'media-links') {
      return created(await linkOptionMedia(user, parseId(parts[1], 'optionId'), mediaLinkSchema.parse(await readJson(request))));
    }

    if (parts[0] === 'practice-sessions' && parts.length === 1) {
      return created(await startPracticeSession(user, practiceStartSchema.parse(await readJson(request))));
    }
    if (parts[0] === 'practice-sessions' && parts[1]) {
      const sessionId = parseId(parts[1], 'sessionId');
      if (parts[2] === 'answers') return created(await submitAnswer(user, sessionId, answerSchema.parse(await readJson(request))));
      if (parts[2] === 'complete') return ok(await completePracticeSession(user, sessionId, 'completed'));
      if (parts[2] === 'abandon') return ok(await completePracticeSession(user, sessionId, 'abandoned'));
    }

    if (parts[0] === 'import-jobs' && parts.length === 1) {
      const body = z.object({
        bankId: z.number().int().positive().optional().nullable(),
        fileName: z.string().optional().nullable(),
        sourceType: z.enum(['txt', 'text', 'docx']).optional().nullable(),
        requestPayload: z.record(z.unknown()).optional()
      }).parse(await readJson(request));
      return created(await createImportJob(user, body));
    }
    if (parts[0] === 'import-jobs' && parts[1]) {
      const jobId = parseId(parts[1], 'jobId');
      if (parts[2] === 'file') {
        if ((request.headers.get('content-type') || '').includes('multipart/form-data')) {
          const formData = await request.formData();
          return created(await addImportJobUploadedFile(user, jobId, formData.get('file')));
        }
        const body = z.object({
          artifactType: z.string().optional(),
          storagePath: z.string().optional().nullable(),
          content: z.record(z.unknown()).optional().nullable(),
          sourceType: z.enum(['txt', 'text', 'docx']).optional().nullable()
        }).parse(await readJson(request));
        return created(await addImportJobFile(user, jobId, body));
      }
      if (parts[2] === 'parse') {
        const body = z.object({ persistQuestions: z.boolean().optional() }).parse(await readJson(request));
        return ok(await queueImportJobForUser(user, jobId, { persistQuestions: body.persistQuestions ?? true }));
      }
      if (parts[2] === 'start') return ok(await updateImportJobStatus(user, jobId, 'start'));
      if (parts[2] === 'retry') return ok(await updateImportJobStatus(user, jobId, 'retry'));
      if (parts[2] === 'cancel') return ok(await updateImportJobStatus(user, jobId, 'cancel'));
      if (parts[2] === 'review-items' && parts[3] && parts[4] === 'resolve') {
        const body = z.object({ note: z.string().optional().nullable() }).parse(await readJson(request));
        return ok(await resolveImportReviewItem(user, jobId, parseId(parts[3], 'reviewItemId'), body.note));
      }
    }

    if (parts[0] === 'media') {
      const body = z.object({
        storagePath: z.string().min(1),
        externalUrl: z.string().url().optional().nullable(),
        originalName: z.string().optional().nullable(),
        mimeType: z.string().optional().nullable(),
        sizeBytes: z.number().int().nonnegative().optional().nullable()
      }).parse(await readJson(request));
      return created(await createMediaAsset(body));
    }

    if (parts[0] === 'ai') {
      const { generateAnswerWithMastra, generateLearningReportWithMastra, parseDocumentWithMastra } = await aiHandlers();
      if (parts[1] === 'parse-document') return ok(await parseDocumentWithMastra(user, aiDocumentParseSchema.parse(await readJson(request))));
      if (parts[1] === 'generate-answer') return ok(await generateAnswerWithMastra(user, aiAnswerSchema.parse(await readJson(request))));
      if (parts[1] === 'learning-report') return ok(await generateLearningReportWithMastra(user, aiReportSchema.parse(await readJson(request))));
    }

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, ctx: Ctx) {
  try {
    assertSameOriginRequest(request);
    const parts = await partsFrom(ctx);
    const user = await requireUser();

    if (parts.join('/') === 'users/me') {
      if ((request.headers.get('content-type') || '').includes('multipart/form-data')) {
        const { isUploadedFile, storeAvatarFile } = await objectStorageHandlers();
        const formData = await request.formData();
        const avatarFile = formData.get('avatar');
        const avatarUrl = isUploadedFile(avatarFile)
          ? (await storeAvatarFile(user.id, avatarFile)).objectUrl
          : undefined;
        const password = String(formData.get('password') || '');
        return ok(await updateCurrentUser(user, {
          username: String(formData.get('username') || '') || undefined,
          email: String(formData.get('email') || '') || null,
          passwordHash: password ? await hashPassword(password) : undefined,
          avatarUrl
        }));
      }

      const body = profileSchema.parse(await readJson(request));
      return ok(await updateCurrentUser(user, {
        username: body.username,
        email: body.email,
        passwordHash: body.password ? await hashPassword(body.password) : undefined,
        avatarUrl: body.avatarUrl
      }));
    }

    if (parts[0] === 'users' && parts[1] && parts[2] === 'status') {
      const body = z.object({ isActive: z.boolean() }).parse(await readJson(request));
      return ok(await setUserStatus(user, parseId(parts[1], 'userId'), body.isActive));
    }

    if (parts[0] === 'knowledge-points' && parts[1]) {
      return ok(await updateKnowledgePoint(user, parseId(parts[1], 'knowledgePointId'), knowledgePointSchema.partial().parse(await readJson(request))));
    }

    if (parts[0] === 'banks' && parts[1]) {
      if (parts[2] === 'items' && parts[3] === 'reorder') {
        const body = z.object({
          items: z.array(z.object({
            questionId: z.number().int().positive().optional(),
            groupId: z.number().int().positive().optional(),
            sortOrder: z.number().int().positive()
          }))
        }).parse(await readJson(request));
        await reorderBankItems(user, parseId(parts[1], 'bankId'), body.items);
        return noContent();
      }
      return ok(await updateBank(user, parseId(parts[1], 'bankId'), z.object({
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).optional().nullable(),
        isPublic: z.boolean().optional()
      }).parse(await readJson(request))));
    }

    if (parts[0] === 'questions' && parts[1]) {
      const questionId = parseId(parts[1], 'questionId');
      if (parts[2] === 'options' && parts[3]) {
        return ok(await updateOption(user, questionId, parseId(parts[3], 'optionId'), optionSchema.partial().parse(await readJson(request))));
      }
      return ok(await updateQuestion(user, questionId, z.object({
        stem: z.string().min(1).optional(),
        analysis: z.string().optional().nullable(),
        status: z.enum(['draft', 'active', 'archived']).optional()
      }).parse(await readJson(request))));
    }

    if (parts[0] === 'groups' && parts[1]) {
      const groupId = parseId(parts[1], 'groupId');
      if (parts[2] === 'questions' && parts[3] === 'reorder') {
        const body = z.object({
          items: z.array(z.object({
            questionId: z.number().int().positive(),
            sortOrder: z.number().int().positive()
          }))
        }).parse(await readJson(request));
        await reorderGroupQuestions(user, groupId, body.items);
        return noContent();
      }
      return ok(await updateGroup(user, groupId, groupSchema.partial().parse(await readJson(request))));
    }

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: Request, ctx: Ctx) {
  try {
    assertSameOriginRequest(request);
    const parts = await partsFrom(ctx);
    const user = await requireUser();

    if (parts[0] === 'questions' && parts[1]) {
      const questionId = parseId(parts[1], 'questionId');
      if (parts[2] === 'answer-key') return ok(await upsertAnswerKey(user, questionId, answerKeySchema.parse(await readJson(request))));
      if (parts[2] === 'metadata') return ok(await upsertQuestionMetadata(user, questionId, metadataSchema.parse(await readJson(request))));
      if (parts[2] === 'knowledge-points') {
        const body = z.object({ knowledgePointIds: z.array(z.number().int().positive()) }).parse(await readJson(request));
        await replaceQuestionKnowledgePoints(user, questionId, body.knowledgePointIds);
        return noContent();
      }
      if (parts[2] === 'content-blocks') {
        await replaceQuestionContentBlocks(user, questionId, contentBlocksSchema.parse(await readJson(request)).blocks);
        return noContent();
      }
    }

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  try {
    assertSameOriginRequest(request);
    const parts = await partsFrom(ctx);
    const user = await requireUser();

    if (parts[0] === 'banks' && parts[1]) {
      if (parts[2] === 'favorite') {
        await setFavorite(user, parseId(parts[1], 'bankId'), false);
        return noContent();
      }
      await deleteBank(user, parseId(parts[1], 'bankId'));
      return noContent();
    }

    if (parts[0] === 'questions' && parts[1]) {
      await deleteQuestion(user, parseId(parts[1], 'questionId'));
      return noContent();
    }

    if (parts[0] === 'groups' && parts[1] && parts[2] === 'questions' && parts[3]) {
      await removeQuestionFromGroup(user, parseId(parts[1], 'groupId'), parseId(parts[3], 'questionId'));
      return noContent();
    }

    if (parts[0] === 'media' && parts[1]) {
      await deleteMediaAsset(user, parseId(parts[1], 'mediaId'));
      return noContent();
    }

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  } catch (error) {
    return handleApiError(error);
  }
}
