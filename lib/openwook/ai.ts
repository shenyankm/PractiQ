import 'server-only';

import mammoth from 'mammoth';
import JSZip from 'jszip';
import { z } from 'zod';
import { sql } from './db';
import { publishImportEvent } from './import-events';
import { readObjectBuffer, relativePathFromObjectUrl } from './object-storage';
import { hashKey, redisGetJson, redisKey, redisSetJson } from './redis';
import {
  answerGeneratorAgent,
  documentParserAgent,
  getMastraModelName,
  isMastraModelConfigured,
  learningReportAgent,
  mastraModelSettings,
  mastraProviderOptions
} from './mastra';
import { requireImportSourceType, requirePlusEntitlement } from './permissions';
import {
  createQuestion,
  getImportJob,
  getQuestion,
  invalidateBankCachesForTest,
  listImportJobChildren,
  resolveQuestionTypeIdForSubject,
  upsertAnswerKey
} from './services';
import type { User } from './types';

export type DocumentParseRequest = {
  importJobId?: number | null;
  bankId?: number | null;
  sourceType: 'docx' | 'txt' | 'text' | 'unknown';
  fileName?: string | null;
  text?: string | null;
  fileBase64?: string | null;
  fileBuffer?: Buffer;
  mimeType?: string | null;
};

export type AnswerGenerationRequest = {
  questionId?: number | null;
  stem: string;
  answerMode: 'choice' | 'true_false' | 'fill_blank' | 'short_answer';
  options?: Array<{ label: string; content: string }>;
  analysis?: string | null;
};

export type LearningReportRequest = {
  userId?: number | null;
  bankId?: number | null;
  practiceSessionId?: number | null;
  scope: 'individual' | 'class' | 'bank';
};

const contentBlockSchema = z.object({
  partType: z.enum(['text', 'formula', 'image', 'table', 'list', 'html', 'markdown', 'chart', 'diagram', 'qr_code']),
  role: z.string().optional().nullable(),
  textValue: z.string().optional().nullable(),
  markdownValue: z.string().optional().nullable(),
  latexValue: z.string().optional().nullable(),
  jsonValue: z.record(z.unknown()).optional().nullable()
});

const parsedQuestionSchema = z.object({
  stem: z.string(),
  answerMode: z.enum(['choice', 'true_false', 'fill_blank', 'short_answer']),
  questionTypeId: z.string(),
  options: z.array(z.object({
    label: z.string(),
    content: z.string(),
    isCorrect: z.boolean().optional()
  })),
  answerPayload: z.record(z.unknown()).optional(),
  analysis: z.string().optional().nullable(),
  contentBlocks: z.array(contentBlockSchema),
  sourceText: z.string().optional().nullable(),
  confidence: z.number().min(0).max(1),
  needsReview: z.boolean()
});

const documentParseSchema = z.object({
  questions: z.array(parsedQuestionSchema),
  groups: z.array(z.object({
    title: z.string(),
    instructions: z.string().optional().nullable(),
    questionIndexes: z.array(z.number().int().nonnegative())
  })),
  visualElements: z.array(z.object({
    kind: z.enum(['image', 'table', 'chart', 'diagram', 'qr_code']),
    label: z.string().optional().nullable(),
    description: z.string(),
    extractedText: z.string().optional().nullable()
  })),
  warnings: z.array(z.string()),
  qualityScore: z.number().min(0).max(100)
});

const answerGenerationSchema = z.object({
  answerPayload: z.record(z.unknown()),
  canonicalAnswer: z.string(),
  explanation: z.string(),
  steps: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  educationalValue: z.string().optional().nullable()
});

const learningReportSchema = z.object({
  summary: z.string(),
  mastery: z.array(z.object({
    label: z.string(),
    score: z.number().min(0).max(1),
    evidence: z.string()
  })),
  weakPoints: z.array(z.object({
    label: z.string(),
    reason: z.string(),
    suggestedAction: z.string()
  })),
  recommendations: z.array(z.string()),
  riskLevel: z.enum(['low', 'medium', 'high'])
});

export type DocumentParseResult = z.infer<typeof documentParseSchema>;
export type AnswerGenerationResult = z.infer<typeof answerGenerationSchema>;
export type LearningReportResult = z.infer<typeof learningReportSchema>;

type NormalizedDocument = {
  text: string;
  html?: string | null;
  warnings: string[];
  visualHints: string[];
  metadata: Record<string, unknown>;
};

type ImportPipelineRecord = {
  blockId: number;
  attemptId: number;
};

export async function parseDocumentWithMastra(user: User, request: DocumentParseRequest) {
  requirePlusEntitlement(user, 'AI document parsing');
  const sourceType = requireImportSourceType(user, request.sourceType);
  const document = await normalizeDocument(request);
  const input = {
    sourceType,
    fileName: request.fileName ?? null,
    mimeType: request.mimeType ?? null,
    text: document.text.slice(0, 80_000),
    html: document.html ? document.html.slice(0, 40_000) : null,
    visualHints: document.visualHints,
    metadata: document.metadata
  };
  const cacheKey = redisKey('cache', 'ai', 'document-parse', hashKey(input));
  const cached = await redisGetJson<DocumentParseResult>(cacheKey);
  const result = cached ?? await runStructuredAgent({
    type: 'document_parse',
    input,
    schema: documentParseSchema,
    prompt: [
      'Parse this source into OpenWook question structures.',
      'Recognize formulas, chemical equations, tables, charts, diagrams, images, and mixed layout hints.',
      `Source type: ${sourceType}`,
      `File name: ${request.fileName ?? 'unknown'}`,
      'Source:',
      document.text,
      document.html ? `HTML:\n${document.html}` : ''
    ].join('\n\n'),
    generate: async () => {
      const output = await documentParserAgent.generate<DocumentParseResult>(
        [{ role: 'user', content: JSON.stringify(input) }],
        {
          modelSettings: mastraModelSettings,
          providerOptions: mastraProviderOptions,
          structuredOutput: {
            schema: documentParseSchema,
            jsonPromptInjection: true,
            providerOptions: mastraProviderOptions
          }
        }
      );
      return output.object;
    },
    fallback: () => fallbackParseDocument(request, document)
  });
  if (!cached) await redisSetJson(cacheKey, result, Number(process.env.AI_CACHE_TTL_SECONDS || 24 * 60 * 60));
  result.warnings = [...document.warnings, ...result.warnings];

  await persistAiArtifact(user, {
    artifactType: 'document_parse',
    bankId: request.bankId ?? null,
    importJobId: request.importJobId ?? null,
    inputPayload: input,
    outputPayload: result
  });
  return result;
}

export async function parseImportJobWithMastra(user: User, importJobId: number, options?: { persistQuestions?: boolean }) {
  requirePlusEntitlement(user, 'AI import parsing');
  const job = await getImportJob(user, importJobId);
  await markImportJobProcessing(importJobId);
  const artifactRows = await listImportJobChildren(user, importJobId, 'artifacts') as unknown as Array<{ content_json: string | null; storage_path: string | null }>;
  const contentParts: string[] = [];
  let fileBuffer: Buffer | null = null;
  let fileBase64: string | null = null;
  let mimeType: string | null = null;
  let fileName = job.file_name;

  for (const artifactRow of artifactRows) {
    const artifact = await hydrateImportArtifact(normalizeImportArtifact(artifactRow));
    const text = artifact.text ?? artifact.content ?? (artifact.storagePath ? `[file:${artifact.storagePath}]` : '');
    if (text) contentParts.push(text);
    if (!fileBuffer && artifact.fileBuffer) fileBuffer = artifact.fileBuffer;
    if (!fileBase64 && artifact.fileBase64) fileBase64 = artifact.fileBase64;
    if (!mimeType && artifact.mimeType) mimeType = artifact.mimeType;
    if (!fileName && artifact.fileName) fileName = artifact.fileName;
  }

  const parsed = await parseDocumentWithMastra(user, {
    importJobId,
    bankId: job.bank_id ? Number(job.bank_id) : null,
    sourceType: normalizeSourceType(job.source_type),
    fileName,
    text: contentParts.join('\n\n') || String(job.request_payload ?? ''),
    fileBase64,
    fileBuffer: fileBuffer ?? undefined,
    mimeType
  });
  const sanitized = await validateDocumentParseResult(parsed, job.bank_id ? Number(job.bank_id) : null);

  const pipelineRecords = await persistImportPipeline(importJobId, sanitized);

  if (options?.persistQuestions !== false && job.bank_id) {
    await persistParsedQuestions(user, importJobId, Number(job.bank_id), sanitized, pipelineRecords);
  }

  await completeImportJob(importJobId, sanitized, {
    importedQuestions: options?.persistQuestions === false || !job.bank_id ? 0 : sanitized.questions.length
  });

  return sanitized;
}

export async function generateAnswerWithMastra(user: User, request: AnswerGenerationRequest) {
  requirePlusEntitlement(user, 'AI answer generation');
  const cacheKey = redisKey('cache', 'ai', 'answer-generation', hashKey(request));
  const cached = await redisGetJson<AnswerGenerationResult>(cacheKey);
  const result = cached ?? await runStructuredAgent({
    type: 'answer_generation',
    input: request,
    schema: answerGenerationSchema,
    prompt: `Generate a standard answer and solving explanation for this question:\n${JSON.stringify(request, null, 2)}`,
    generate: async () => {
      const output = await answerGeneratorAgent.generate<AnswerGenerationResult>(
        [{ role: 'user', content: JSON.stringify(request) }],
        {
          modelSettings: mastraModelSettings,
          providerOptions: mastraProviderOptions,
          structuredOutput: {
            schema: answerGenerationSchema,
            jsonPromptInjection: true,
            providerOptions: mastraProviderOptions
          }
        }
      );
      return output.object;
    },
    fallback: () => fallbackGenerateAnswer(request)
  });
  if (!cached) await redisSetJson(cacheKey, result, Number(process.env.AI_CACHE_TTL_SECONDS || 24 * 60 * 60));

  await persistAiArtifact(user, {
    artifactType: 'answer_generation',
    questionId: request.questionId ?? null,
    inputPayload: request,
    outputPayload: result
  });
  return result;
}

export async function generateQuestionAnswerWithMastra(user: User, questionId: number, options?: { apply?: boolean }) {
  const question = await getQuestion(user, questionId) as {
    id: number;
    stem: string;
    answer_mode: AnswerGenerationRequest['answerMode'];
    analysis: string | null;
    options?: Array<{ option_label: string; content: string }>;
  };
  const result = await generateAnswerWithMastra(user, {
    questionId,
    stem: question.stem,
    answerMode: question.answer_mode,
    analysis: question.analysis,
    options: (question.options ?? []).map((option) => ({ label: option.option_label, content: option.content }))
  });

  if (options?.apply !== false) {
    if (result.confidence < Number(process.env.AI_APPLY_MIN_CONFIDENCE || 0.7)) {
      throw new Error('AI generated answer confidence is too low to apply automatically');
    }
    if (!hasUsableParsedAnswer(question.answer_mode, result.answerPayload)) {
      throw new Error('AI generated answer is incomplete and cannot be applied');
    }
    await upsertAnswerKey(user, questionId, {
      answerMode: question.answer_mode,
      answerPayload: result.answerPayload,
      explanationPayload: {
        canonicalAnswer: result.canonicalAnswer,
        explanation: result.explanation,
        steps: result.steps,
        confidence: result.confidence,
        educationalValue: result.educationalValue
      },
      scorePayload: { maxScore: 1, generatedBy: 'mastra' }
    });
  }

  return result;
}

export async function generateLearningReportWithMastra(user: User, request: LearningReportRequest) {
  requirePlusEntitlement(user, 'AI learning reports');
  const sourceData = await loadLearningReportSource(user, request);
  const cacheKey = redisKey('cache', 'ai', 'learning-report', hashKey(sourceData));
  const cached = await redisGetJson<LearningReportResult>(cacheKey);
  const result = cached ?? await runStructuredAgent({
    type: 'learning_report',
    input: sourceData,
    schema: learningReportSchema,
    prompt: `Generate a learning report from OpenWook practice data:\n${JSON.stringify(sourceData, null, 2)}`,
    generate: async () => {
      const output = await learningReportAgent.generate<LearningReportResult>(
        [{ role: 'user', content: JSON.stringify(sourceData) }],
        {
          modelSettings: mastraModelSettings,
          providerOptions: mastraProviderOptions,
          structuredOutput: {
            schema: learningReportSchema,
            jsonPromptInjection: true,
            providerOptions: mastraProviderOptions
          }
        }
      );
      return output.object;
    },
    fallback: () => fallbackLearningReport(sourceData)
  });
  if (!cached) await redisSetJson(cacheKey, result, Number(process.env.AI_REPORT_CACHE_TTL_SECONDS || 3600));

  await persistAiArtifact(user, {
    artifactType: 'learning_report',
    bankId: request.bankId ?? null,
    practiceSessionId: request.practiceSessionId ?? null,
    inputPayload: sourceData,
    outputPayload: result
  });
  return result;
}

export async function getAiArtifacts(user: User, params: URLSearchParams) {
  const artifactType = params.get('type');
  const questionId = params.get('questionId');
  const importJobId = params.get('importJobId');
  return sql`
    SELECT *
    FROM ai_artifacts
    WHERE user_id = ${user.id}
      AND (${artifactType ?? null}::text IS NULL OR artifact_type = ${artifactType ?? null})
      AND (${questionId ?? null}::bigint IS NULL OR question_id = ${questionId ? Number(questionId) : null})
      AND (${importJobId ?? null}::bigint IS NULL OR import_job_id = ${importJobId ? Number(importJobId) : null})
    ORDER BY created_at DESC
    LIMIT 50
  `;
}

async function persistParsedQuestions(
  user: User,
  importJobId: number,
  bankId: number,
  parsed: DocumentParseResult,
  pipelineRecords: ImportPipelineRecord[]
) {
  const outputRows: Array<{
    job_id: number;
    block_id: number | null;
    attempt_id: number | null;
    output_kind: 'question';
    question_id: number;
    confidence: number;
    metadata_json: string;
  }> = [];
  const provenanceRows: Array<{
    question_id: number;
    source_job_id: number;
    source_block_ref: string | null;
    source_text: string;
    confidence: number;
    metadata_json: string;
  }> = [];
  const reviewRows: Array<{
    job_id: number;
    severity: 'medium';
    code: string;
    payload_json: string;
  }> = [];
  const contentBlockRows: Array<{
    question_id: number;
    owner_kind: 'question';
    role: string | null;
    part_type: string;
    sequence: number;
    content_mode: 'structured_rich';
    text_format: string;
    text_value: string | null;
    latex_value: string | null;
    markdown_value: string | null;
    json_value: string | null;
    metadata_json: string;
  }> = [];

  for (const [index, parsedQuestion] of parsed.questions.entries()) {
    const pipelineRecord = pipelineRecords[index] ?? null;
    const question = await createQuestion(user, bankId, {
      questionTypeId: parsedQuestion.questionTypeId || 'generic_answer_mode',
      answerMode: parsedQuestion.answerMode,
      stem: parsedQuestion.stem,
      analysis: parsedQuestion.analysis ?? null,
      choiceVariant: parsedQuestion.answerMode === 'choice' ? 'single' : null,
      status: parsedQuestion.needsReview ? 'draft' : 'active',
      options: parsedQuestion.options,
      answerPayload: parsedQuestion.answerPayload ?? {}
    }, {
      invalidateCaches: false,
      resolveQuestionType: false
    });
    await sql`
      UPDATE questions
      SET source_type = 'imported', source_job_id = ${importJobId}
      WHERE id = ${question.id}
    `;
    outputRows.push({
      job_id: importJobId,
      block_id: pipelineRecord?.blockId ?? null,
      attempt_id: pipelineRecord?.attemptId ?? null,
      output_kind: 'question',
      question_id: Number(question.id),
      confidence: parsedQuestion.confidence,
      metadata_json: JSON.stringify({ index, source: 'mastra' })
    });
    provenanceRows.push({
      question_id: Number(question.id),
      source_job_id: importJobId,
      source_block_ref: pipelineRecord ? `mastra-q${index + 1}` : null,
      source_text: parsedQuestion.sourceText ?? parsedQuestion.stem,
      confidence: parsedQuestion.confidence,
      metadata_json: JSON.stringify({ source: 'mastra' })
    });
    contentBlockRows.push(...questionContentBlockRows(question.id, parsedQuestion.contentBlocks));
    if (parsedQuestion.needsReview) {
      reviewRows.push({
        job_id: importJobId,
        severity: 'medium',
        code: 'AI_NEEDS_REVIEW',
        payload_json: JSON.stringify({ questionId: question.id, blockId: pipelineRecord?.blockId ?? null, stem: parsedQuestion.stem })
      });
    }
  }
  if (outputRows.length) {
    await sql`
      INSERT INTO question_import_job_outputs ${sql(outputRows, 'job_id', 'block_id', 'attempt_id', 'output_kind', 'question_id', 'confidence', 'metadata_json')}
      ON CONFLICT DO NOTHING
    `;
  }
  if (provenanceRows.length) {
    await sql`
      INSERT INTO question_provenance ${sql(provenanceRows, 'question_id', 'source_job_id', 'source_block_ref', 'source_text', 'confidence', 'metadata_json')}
    `;
  }
  if (contentBlockRows.length) {
    await sql`
      INSERT INTO question_content_blocks ${
        sql(contentBlockRows, 'question_id', 'owner_kind', 'role', 'part_type', 'sequence', 'content_mode', 'text_format', 'text_value', 'latex_value', 'markdown_value', 'json_value', 'metadata_json')
      }
    `;
  }
  if (reviewRows.length) {
    await sql`
      INSERT INTO question_import_job_review_items ${sql(reviewRows, 'job_id', 'severity', 'code', 'payload_json')}
    `;
  }
  await invalidateBankCachesForTest(bankId, user.id);
}

async function validateDocumentParseResult(parsed: DocumentParseResult, bankId: number | null): Promise<DocumentParseResult> {
  const subject = bankId ? await loadBankSubject(bankId) : null;
  const questions = [];
  const warnings = [...parsed.warnings];

  for (const [index, question] of parsed.questions.entries()) {
    const stem = question.stem.trim();
    if (!stem) {
      warnings.push(`Question ${index + 1} was discarded because its stem is empty.`);
      continue;
    }

    const hasAnswer = hasUsableParsedAnswer(question.answerMode, question.answerPayload);
    const hasChoiceOptions = question.answerMode !== 'choice'
      || (question.options.length >= 2 && question.options.some((option) => option.isCorrect));
    const compatibleTypeId = subject
      ? await resolveQuestionTypeIdForSubject(subject, question.questionTypeId, question.answerMode)
      : question.questionTypeId || 'generic_answer_mode';

    questions.push({
      ...question,
      stem,
      questionTypeId: compatibleTypeId,
      options: question.answerMode === 'choice' ? normalizeParsedOptions(question.options, question.answerPayload) : [],
      needsReview: question.needsReview || !hasAnswer || !hasChoiceOptions || question.confidence < 0.7,
      confidence: Math.max(0, Math.min(1, question.confidence))
    });
  }

  if (parsed.questions.length > 0 && questions.length === 0) {
    throw new Error('AI parser did not produce any valid questions');
  }

  return {
    ...parsed,
    questions,
    warnings,
    qualityScore: Math.max(0, Math.min(100, parsed.qualityScore))
  };
}

async function loadBankSubject(bankId: number) {
  const rows = await sql<Array<{ subject: string }>>`
    SELECT subject
    FROM question_banks
    WHERE id = ${bankId}
    LIMIT 1
  `;
  if (!rows[0]) throw new Error(`Question bank ${bankId} is unavailable`);
  return rows[0].subject;
}

function normalizeParsedOptions(
  options: Array<{ label: string; content: string; isCorrect?: boolean }>,
  answerPayload: Record<string, unknown> | undefined
) {
  const selected = new Set(normalizeStringArray(objectValue(answerPayload, 'selected')));
  return options
    .map((option) => ({
      label: option.label.trim().toUpperCase(),
      content: option.content.trim(),
      isCorrect: option.isCorrect ?? selected.has(option.label.trim().toUpperCase())
    }))
    .filter((option, index, all) => option.label && option.content && all.findIndex((item) => item.label === option.label) === index);
}

function normalizeSourceType(value: string | null): DocumentParseRequest['sourceType'] {
  if (value === 'docx' || value === 'txt' || value === 'text') return value;
  return 'unknown';
}

type NormalizedImportArtifact = {
  text: string | null;
  content: string | null;
  fileBase64: string | null;
  fileBuffer: Buffer | null;
  mimeType: string | null;
  relativePath: string | null;
  storagePath: string | null;
  fileName: string | null;
};

function normalizeImportArtifact(artifact: { content_json: string | null; storage_path: string | null }): NormalizedImportArtifact {
  const parsed = artifact.content_json ? safeArtifactContent(artifact.content_json) : {};
  const objectKey = typeof parsed.objectKey === 'string' ? parsed.objectKey : null;
  const legacyRelativePath = typeof parsed.relativePath === 'string' ? parsed.relativePath : null;
  const relativePath = objectKey ?? legacyRelativePath ?? relativePathFromObjectUrl(artifact.storage_path);
  return {
    text: typeof parsed.text === 'string' ? parsed.text : null,
    content: typeof parsed.content === 'string' ? parsed.content : null,
    fileBase64: typeof parsed.fileBase64 === 'string' ? parsed.fileBase64 : null,
    fileBuffer: null,
    mimeType: typeof parsed.mimeType === 'string' ? parsed.mimeType : null,
    relativePath,
    fileName: typeof parsed.originalName === 'string' ? parsed.originalName : null,
    storagePath: artifact.storage_path
  };
}

async function hydrateImportArtifact(artifact: NormalizedImportArtifact): Promise<NormalizedImportArtifact> {
  if (artifact.text || artifact.fileBase64 || artifact.fileBuffer || !artifact.relativePath) return artifact;

  const buffer = await readObjectBuffer(artifact.relativePath);
  const mimeType = artifact.mimeType ?? inferMimeTypeFromName(artifact.fileName ?? artifact.relativePath);
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || artifact.relativePath.toLowerCase().endsWith('.docx')) {
    return {
      ...artifact,
      fileBuffer: buffer,
      mimeType
    };
  }

  return {
    ...artifact,
    text: buffer.toString('utf8').replace(/^\uFEFF/, ''),
    mimeType: mimeType ?? 'text/plain'
  };
}

function inferMimeTypeFromName(name: string) {
  const normalizedName = name.toLowerCase();
  if (normalizedName.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (normalizedName.endsWith('.txt')) return 'text/plain';
  return null;
}

function safeArtifactContent(contentJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(contentJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { text: contentJson };
  } catch {
    return { text: contentJson };
  }
}

function objectValue(value: unknown, key: string) {
  return value && typeof value === 'object' && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function normalizeStringArray(value: unknown) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.map((item) => String(item).trim()).filter(Boolean).sort();
}

function normalizeText(value: unknown) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function parsedFillBlankValues(payload: Record<string, unknown> | undefined) {
  if (!payload) return [];
  const directValue = objectValue(payload, 'value');
  if (Array.isArray(directValue)) return directValue.map(normalizeText).filter(Boolean);
  if (directValue !== undefined && directValue !== null) return [normalizeText(directValue)].filter(Boolean);

  const slots = objectValue(payload, 'slots');
  if (!Array.isArray(slots)) return [];
  return slots.flatMap((slot) => {
    if (!slot || typeof slot !== 'object') return [];
    const record = slot as Record<string, unknown>;
    const nested = record.answers ?? record.value;
    const list = Array.isArray(nested) ? nested : [nested];
    return list.map(normalizeText).filter(Boolean);
  });
}

function hasUsableParsedAnswer(answerMode: AnswerGenerationRequest['answerMode'], payload: Record<string, unknown> | undefined) {
  if (!payload) return false;
  if (answerMode === 'choice') return normalizeStringArray(objectValue(payload, 'selected')).length > 0;
  if (answerMode === 'true_false') return typeof payload.value === 'boolean';
  if (answerMode === 'fill_blank') return parsedFillBlankValues(payload).length > 0;
  return normalizeText(payload.value).length > 0;
}

async function markImportJobProcessing(importJobId: number) {
  const event = await sql<Array<{ id: number }>>`
    INSERT INTO question_import_job_events (job_id, stage, step_code, step_label, status, message, overall_progress_percent, step_progress_percent)
    VALUES (${importJobId}, 'processing', 'mastra_parse_start', 'Mastra 文档解析', 'processing', 'Mastra document parsing started', 5, 5)
    RETURNING id
  `;
  await sql`
    UPDATE question_import_jobs
    SET
      status = 'processing',
      stage = 'processing',
      current_step_code = 'mastra_parse_start',
      current_step_label = 'Mastra 文档解析',
      overall_progress_percent = 5,
      step_progress_percent = 5,
      last_event_id = ${event[0]?.id ?? null},
      last_event_at = NOW(),
      completed_at = NULL,
      last_error = NULL,
      last_error_code = NULL
    WHERE id = ${importJobId}
  `;
  await enqueueImportOutbox(importJobId, event[0]?.id ?? null, 'import.job.processing', { importJobId, stage: 'processing' });
  if (event[0]) await publishImportEvent(importJobId, event[0]);
}

async function persistImportPipeline(importJobId: number, parsed: DocumentParseResult): Promise<ImportPipelineRecord[]> {
  const batchRows = await sql<Array<{ id: number }>>`
    INSERT INTO question_import_job_batches (job_id, wave_index, status, total_blocks, completed_blocks, failed_blocks)
    VALUES (${importJobId}, 1, 'completed', ${parsed.questions.length}, ${parsed.questions.length}, 0)
    ON CONFLICT (job_id, wave_index)
    DO UPDATE SET
      status = 'completed',
      total_blocks = EXCLUDED.total_blocks,
      completed_blocks = EXCLUDED.completed_blocks,
      failed_blocks = 0
    RETURNING id
  `;
  const batchId = batchRows[0].id;
  const records: ImportPipelineRecord[] = [];

  for (const [index, question] of parsed.questions.entries()) {
    const blockKey = `mastra-q${index + 1}`;
    const blockRows = await sql<Array<{ id: number }>>`
      INSERT INTO question_import_job_blocks (
        job_id, batch_id, block_id, block_type, char_start, char_end, scene_hint, metadata_json,
        parser_profile, status, risk_level, confidence, coverage, completed_at
      )
      VALUES (
        ${importJobId}, ${batchId}, ${blockKey}, 'question',
        NULL, NULL, ${question.answerMode}, ${JSON.stringify({ index, needsReview: question.needsReview })},
        'mastra', ${question.needsReview ? 'needs_review' : 'completed'}, ${question.needsReview ? 'medium' : 'low'},
        ${question.confidence}, ${question.confidence}, CASE WHEN ${question.needsReview} THEN NULL ELSE NOW() END
      )
      ON CONFLICT (job_id, block_id)
      DO UPDATE SET
        batch_id = EXCLUDED.batch_id,
        metadata_json = EXCLUDED.metadata_json,
        status = EXCLUDED.status,
        risk_level = EXCLUDED.risk_level,
        confidence = EXCLUDED.confidence,
        coverage = EXCLUDED.coverage,
        completed_at = EXCLUDED.completed_at
      RETURNING id
    `;
    const blockId = blockRows[0].id;
    const attemptRows = await sql<Array<{ id: number }>>`
      INSERT INTO question_import_job_block_attempts (
        block_id, attempt_no, parser_profile, raw_output_json, issues_json, confidence, coverage, quality_score
      )
      VALUES (
        ${blockId}, 1, 'mastra', ${JSON.stringify(question)}, ${JSON.stringify(question.needsReview ? ['needs_review'] : [])},
        ${question.confidence}, ${question.confidence}, ${Math.round(question.confidence * 100)}
      )
      ON CONFLICT (block_id, attempt_no)
      DO UPDATE SET
        raw_output_json = EXCLUDED.raw_output_json,
        issues_json = EXCLUDED.issues_json,
        confidence = EXCLUDED.confidence,
        coverage = EXCLUDED.coverage,
        quality_score = EXCLUDED.quality_score
      RETURNING id
    `;
    const attemptId = attemptRows[0].id;
    await sql`
      UPDATE question_import_job_blocks
      SET selected_attempt_id = ${attemptId}
      WHERE id = ${blockId}
    `;
    records.push({ blockId, attemptId });
  }

  if (parsed.visualElements.length) {
    await sql`
      INSERT INTO question_import_job_pages (job_id, page_no, layout_json, complexity_score, coverage_status, render_profile, analysis_status)
      VALUES (${importJobId}, 1, ${JSON.stringify({ visualElements: parsed.visualElements })}, ${parsed.qualityScore}, 'partial', 'mastra', 'completed')
      ON CONFLICT (job_id, page_no)
      DO UPDATE SET
        layout_json = EXCLUDED.layout_json,
        complexity_score = EXCLUDED.complexity_score,
        coverage_status = EXCLUDED.coverage_status,
        analysis_status = EXCLUDED.analysis_status
    `;
  }

  return records;
}

async function completeImportJob(importJobId: number, parsed: DocumentParseResult, options: { importedQuestions: number }) {
  const reviewCount = parsed.questions.filter((question) => question.needsReview).length;
  const riskLevel = reviewCount > 0 ? 'medium' : 'low';
  const event = await sql<Array<{ id: number }>>`
    INSERT INTO question_import_job_events (
      job_id, stage, step_code, step_label, status, message, overall_progress_percent, step_progress_percent, payload_json
    )
    VALUES (
      ${importJobId}, 'completed', 'mastra_parse', 'Mastra 文档解析', 'completed',
      'Mastra document parsing completed', 100, 100, ${JSON.stringify({ questionCount: parsed.questions.length, reviewCount })}
    )
    RETURNING id
  `;
  await sql`
    UPDATE question_import_jobs
    SET
      status = 'completed',
      stage = 'completed',
      raw_result_json = ${JSON.stringify(parsed)},
      total_questions = ${parsed.questions.length},
      imported_questions = ${options.importedQuestions},
      page_count = CASE WHEN ${parsed.visualElements.length} > 0 THEN GREATEST(page_count, 1) ELSE page_count END,
      wave_count = 1,
      block_count = ${parsed.questions.length},
      completed_block_count = ${parsed.questions.filter((question) => !question.needsReview).length},
      failed_block_count = 0,
      high_risk_block_count = 0,
      review_item_count = ${reviewCount},
      warning_messages = ${JSON.stringify(parsed.warnings)},
      quality_score = ${parsed.qualityScore},
      coverage_percent = ${parsed.questions.length ? 100 : 0},
      risk_level = ${riskLevel},
      current_step_code = 'mastra_parse',
      current_step_label = 'Mastra 文档解析',
      overall_progress_percent = 100,
      step_progress_percent = 100,
      last_event_id = ${event[0]?.id ?? null},
      last_event_at = NOW(),
      completed_at = NOW()
    WHERE id = ${importJobId}
  `;
  await enqueueImportOutbox(importJobId, event[0]?.id ?? null, 'import.job.completed', {
    importJobId,
    questionCount: parsed.questions.length,
    reviewCount
  });
  if (event[0]) await publishImportEvent(importJobId, event[0]);
}

async function enqueueImportOutbox(importJobId: number, eventId: number | null, eventType: string, payload: Record<string, unknown>) {
  await sql`
    INSERT INTO question_import_outbox_events (job_id, job_event_id, event_type, routing_key, payload_json)
    VALUES (${importJobId}, ${eventId}, ${eventType}, ${eventType.replace(/\./g, '_')}, ${JSON.stringify(payload)})
  `;
}

function questionContentBlockRows(questionId: number, blocks: z.infer<typeof contentBlockSchema>[]) {
  return blocks.map((block, index) => ({
    question_id: questionId,
    owner_kind: 'question' as const,
    role: block.role ?? null,
    part_type: block.partType,
    sequence: index + 1,
    content_mode: 'structured_rich' as const,
    text_format: block.partType === 'markdown' || block.markdownValue ? 'markdown' : 'plain',
    text_value: block.textValue ?? null,
    latex_value: block.latexValue ?? null,
    markdown_value: block.markdownValue ?? null,
    json_value: block.jsonValue ? JSON.stringify(block.jsonValue) : null,
    metadata_json: JSON.stringify({ source: 'mastra' })
  }));
}

async function runStructuredAgent<T>({
  type,
  schema,
  generate,
  fallback
}: {
  type: string;
  input: unknown;
  schema: z.ZodType<T>;
  prompt: string;
  generate: () => Promise<T>;
  fallback: () => T;
}) {
  if (!isMastraModelConfigured()) return schema.parse(fallback());
  try {
    return schema.parse(await generate());
  } catch (error) {
    console.error(`Mastra ${type} failed; falling back to deterministic implementation`, error);
    return schema.parse(fallback());
  }
}

async function normalizeDocument(request: DocumentParseRequest): Promise<NormalizedDocument> {
  const baseText = request.text?.trim() ?? '';
  const warnings: string[] = [];
  const visualHints: string[] = [];
  const metadata: Record<string, unknown> = {};

  const fileBuffer = request.fileBuffer ?? (request.fileBase64 ? Buffer.from(stripDataUriPrefix(request.fileBase64), 'base64') : null);

  if (fileBuffer && request.sourceType === 'docx') {
    const htmlResult = await mammoth.convertToHtml({ buffer: fileBuffer }, {
      convertImage: mammoth.images.imgElement(async (image) => {
        const content = await image.readAsBuffer();
        visualHints.push(`image:${image.contentType}:${content.length}bytes`);
        return { src: '' };
      })
    });
    const rawTextResult = await mammoth.extractRawText({ buffer: fileBuffer });
    const ooxml = await extractDocxOoxmlHints(fileBuffer);
    metadata.mammothMessages = [...htmlResult.messages, ...rawTextResult.messages].map((message) => message.message);
    metadata.ooxml = ooxml.metadata;
    metadata.byteLength = fileBuffer.length;
    warnings.push(...htmlResult.messages.map((message) => `docx html: ${message.message}`));
    warnings.push(...rawTextResult.messages.map((message) => `docx text: ${message.message}`));
    visualHints.push(...ooxml.visualHints);
    const text = [
      baseText,
      rawTextResult.value,
      ooxml.text
    ].filter(Boolean).join('\n\n');
    return {
      text: text.trim(),
      html: htmlResult.value,
      warnings,
      visualHints,
      metadata
    };
  }

  if (fileBuffer) {
    const decoded = fileBuffer.toString('utf8').replace(/^\uFEFF/, '');
    return {
      text: [baseText, decoded].filter(Boolean).join('\n\n').trim(),
      html: null,
      warnings,
      visualHints,
      metadata: { ...metadata, byteLength: fileBuffer.length }
    };
  }

  return {
    text: baseText,
    html: null,
    warnings,
    visualHints,
    metadata
  };
}

async function extractDocxOoxmlHints(buffer: Buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('text') ?? '';
    const chartFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/charts/') && name.endsWith('.xml'));
    const imageFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/media/'));
    const tableCount = countMatches(documentXml, '<w:tbl');
    const formulaCount = countMatches(documentXml, '<m:oMath');
    const drawingCount = countMatches(documentXml, '<w:drawing');
    const chemistryLikeText = extractXmlText(documentXml).filter((value) => /(?:[A-Z][a-z]?\d*|→|⇌|\+)\s*(?:[+=→⇌]|$)/.test(value)).slice(0, 20);
    const chartSummaries = await Promise.all(chartFiles.slice(0, 8).map(async (fileName) => {
      const xml = await zip.file(fileName)?.async('text') ?? '';
      return {
        fileName,
        title: extractXmlText(xml).slice(0, 10).join(' / '),
        pointCount: countMatches(xml, '<c:pt ')
      };
    }));
    const visualHints = [
      tableCount ? `tables:${tableCount}` : '',
      formulaCount ? `formulas:${formulaCount}` : '',
      drawingCount ? `drawings:${drawingCount}` : '',
      imageFiles.length ? `embeddedImages:${imageFiles.length}` : '',
      chartFiles.length ? `charts:${chartFiles.length}` : ''
    ].filter(Boolean);
    return {
      text: [
        formulaCount ? `[docx formulas detected: ${formulaCount}]` : '',
        tableCount ? `[docx tables detected: ${tableCount}]` : '',
        chartSummaries.length ? `[docx charts] ${JSON.stringify(chartSummaries)}` : '',
        chemistryLikeText.length ? `[chemistry-like expressions] ${chemistryLikeText.join('; ')}` : ''
      ].filter(Boolean).join('\n'),
      visualHints,
      metadata: {
        tableCount,
        formulaCount,
        drawingCount,
        embeddedImageCount: imageFiles.length,
        chartCount: chartFiles.length,
        chartSummaries,
        chemistryLikeText
      }
    };
  } catch (error) {
    return {
      text: '',
      visualHints: [],
      metadata: { ooxmlError: error instanceof Error ? error.message : String(error) }
    };
  }
}

function stripDataUriPrefix(value: string) {
  return value.replace(/^data:[^;]+;base64,/, '');
}

function countMatches(value: string, pattern: string) {
  return value.split(pattern).length - 1;
}

function extractXmlText(xml: string) {
  return Array.from(xml.matchAll(/<[^:>]+:t[^>]*>(.*?)<\/[^:>]+:t>/g))
    .map((match) => decodeXmlEntities(match[1] ?? '').trim())
    .filter(Boolean);
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function fallbackParseDocument(request: DocumentParseRequest, document: NormalizedDocument): DocumentParseResult {
  const source = document.text || request.text || '';
  const chunks = source
    .split(/\n\s*\n|(?=^\s*(?:\d+[\.)、]|[一二三四五六七八九十]+[、.]))/m)
    .map((item) => item.trim())
    .filter(Boolean);
  const questions = chunks.length ? chunks.map((chunk) => parseQuestionChunk(chunk)) : [parseQuestionChunk(source)];
  const visualElements = extractVisualHints([source, document.html, document.visualHints.join('\n')].filter(Boolean).join('\n'));
  return {
    questions,
    groups: [],
    visualElements,
    warnings: [
      'Mastra model is not configured; deterministic parser was used.',
      ...(visualElements.length ? ['Visual elements were detected as textual placeholders and need review.'] : [])
    ],
    qualityScore: isMastraModelConfigured() ? 75 : 55
  };
}

function parseQuestionChunk(chunk: string): z.infer<typeof parsedQuestionSchema> {
  const lines = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
  const optionLines = lines.filter((line) => /^[A-D][\.)、]\s*/i.test(line));
  const stemLines = optionLines.length ? lines.filter((line) => !/^[A-D][\.)、]\s*/i.test(line)) : lines;
  const answerLine = lines.find((line) => /^(答案|answer)[:：]/i.test(line));
  const answerText = answerLine?.replace(/^(答案|answer)[:：]\s*/i, '').trim();
  const options = optionLines.map((line) => {
    const [, label = '', content = ''] = line.match(/^([A-D])[\.)、]\s*(.*)$/i) ?? [];
    return { label: label.toUpperCase(), content, isCorrect: answerText?.toUpperCase() === label.toUpperCase() };
  });
  const answerMode = options.length >= 2 ? 'choice' : /^(判断|true|false|对|错)/i.test(answerText ?? '') ? 'true_false' : 'short_answer';
  return {
    stem: stemLines.join('\n').replace(/^(答案|answer)[:：].*$/gim, '').trim() || chunk.slice(0, 500),
    answerMode,
    questionTypeId: 'generic_answer_mode',
    options,
    answerPayload: answerText ? answerPayloadFromText(answerMode, answerText) : undefined,
    analysis: null,
    contentBlocks: extractContentBlocks(chunk),
    sourceText: chunk,
    confidence: options.length || answerText ? 0.72 : 0.52,
    needsReview: !answerText
  };
}

function answerPayloadFromText(answerMode: string, answerText: string) {
  if (answerMode === 'choice') return { selected: answerText.split(/[,\s，]+/).filter(Boolean).map((item) => item.toUpperCase()) };
  if (answerMode === 'true_false') return { value: /true|对|正确/i.test(answerText) };
  return { value: answerText };
}

function extractContentBlocks(text: string) {
  const blocks: z.infer<typeof contentBlockSchema>[] = [];
  const formulaMatches = text.match(/\$[^$]+\$|\\\([^)]+\\\)|[A-Z][a-z]?\s*\+\s*[A-Z][a-z]?|=|→|⇌/g) ?? [];
  for (const value of formulaMatches.slice(0, 10)) {
    blocks.push({ partType: value.includes('$') || value.includes('\\(') ? 'formula' : 'text', role: 'detected_symbol', textValue: value });
  }
  if (/\|.+\|/.test(text) || /表格|table/i.test(text)) {
    blocks.push({ partType: 'table', role: 'detected_table', markdownValue: text.split('\n').filter((line) => line.includes('|')).join('\n') || null });
  }
  if (/图|图片|diagram|chart|图表/i.test(text)) {
    blocks.push({ partType: /chart|图表/i.test(text) ? 'chart' : 'diagram', role: 'visual_hint', textValue: 'Source contains visual element hint.' });
  }
  return blocks;
}

function extractVisualHints(text: string) {
  const hints: DocumentParseResult['visualElements'] = [];
  if (/图|图片|diagram/i.test(text)) hints.push({ kind: 'diagram', description: 'Detected diagram/image reference in source text.' });
  if (/表格|table|\|.+\|/i.test(text)) hints.push({ kind: 'table', description: 'Detected table-like content in source text.' });
  if (/图表|chart/i.test(text)) hints.push({ kind: 'chart', description: 'Detected chart reference in source text.' });
  return hints;
}

function fallbackGenerateAnswer(request: AnswerGenerationRequest): AnswerGenerationResult {
  if (request.answerMode === 'choice' && request.options?.length) {
    const first = request.options[0];
    return {
      answerPayload: { selected: [first.label] },
      canonicalAnswer: first.label,
      explanation: '未配置 Mastra 模型，系统使用可复核的占位答案。请教师确认正确选项。',
      steps: ['阅读题干。', `检查选项，暂取 ${first.label} 作为待复核答案。`],
      confidence: 0.35,
      educationalValue: '低置信度占位答案，需人工审核。'
    };
  }
  return {
    answerPayload: { value: '' },
    canonicalAnswer: '',
    explanation: '未配置 Mastra 模型，无法可靠生成答案。请补充标准答案或配置 OPENAI_API_KEY。',
    steps: ['等待教师补全答案。'],
    confidence: 0.2,
    educationalValue: '用于标记缺失答案，不应直接发布。'
  };
}

async function loadLearningReportSource(user: User, request: LearningReportRequest) {
  const targetUserId = request.userId ?? user.id;
  if (targetUserId !== user.id && user.role !== 'admin') {
    throw new Error('Administrator privileges required to generate reports for other users');
  }
  if (request.bankId) {
    await ensureReportBankAccess(user, request.bankId);
  }
  if (request.practiceSessionId) {
    await ensureReportPracticeSessionAccess(user, request.practiceSessionId, targetUserId);
  }
  const rows = await sql`
    SELECT
      uqs.question_id,
      uqs.attempt_count,
      uqs.correct_count,
      uqs.wrong_count,
      uqs.mastery_score,
      q.stem,
      q.question_type_id,
      q.answer_mode,
      q.subject_id
    FROM user_question_stats uqs
    JOIN questions q ON q.id = uqs.question_id
    WHERE uqs.user_id = ${targetUserId}
      AND (${request.bankId ?? null}::bigint IS NULL OR EXISTS (
        SELECT 1 FROM bank_question_links bql
        WHERE bql.question_id = q.id AND bql.bank_id = ${request.bankId ?? null}
      ))
    ORDER BY uqs.last_answered_at DESC NULLS LAST, uqs.id DESC
    LIMIT 100
  `;
  return {
    scope: request.scope,
    userId: targetUserId,
    bankId: request.bankId ?? null,
    practiceSessionId: request.practiceSessionId ?? null,
    stats: rows
  };
}

async function ensureReportBankAccess(user: User, bankId: number) {
  const rows = await sql<Array<{ id: number }>>`
    SELECT b.id
    FROM question_banks b
    LEFT JOIN user_bank_links ubl
      ON ubl.bank_id = b.id
     AND ubl.user_id = ${user.id}
    WHERE b.id = ${bankId}
      AND (${user.role === 'admin'} OR b.is_public = true OR ubl.id IS NOT NULL)
    LIMIT 1
  `;
  if (!rows[0]) throw new Error('Question bank access required for learning report');
}

async function ensureReportPracticeSessionAccess(user: User, sessionId: number, targetUserId: number) {
  const rows = await sql<Array<{ id: number }>>`
    SELECT id
    FROM user_practice_sessions
    WHERE id = ${sessionId}
      AND (${user.role === 'admin'} OR user_id = ${user.id})
      AND user_id = ${targetUserId}
    LIMIT 1
  `;
  if (!rows[0]) throw new Error('Practice session access required for learning report');
}

function fallbackLearningReport(source: { stats?: Array<Record<string, unknown>>; scope?: string }): LearningReportResult {
  const stats = source.stats ?? [];
  const attempts = stats.reduce((sum, item) => sum + Number(item.attempt_count ?? 0), 0);
  const correct = stats.reduce((sum, item) => sum + Number(item.correct_count ?? 0), 0);
  const accuracy = attempts ? correct / attempts : 0;
  const weak = stats
    .filter((item) => Number(item.mastery_score ?? 0) < 0.6)
    .slice(0, 5)
    .map((item) => ({
      label: String(item.question_type_id ?? item.question_id),
      reason: `正确率/掌握度偏低，当前 mastery=${Number(item.mastery_score ?? 0).toFixed(2)}`,
      suggestedAction: '复习相关知识点，并完成同类题的针对性练习。'
    }));
  return {
    summary: attempts
      ? `共统计 ${attempts} 次作答，正确率 ${Math.round(accuracy * 100)}%。`
      : '暂无足够答题数据生成完整报告。',
    mastery: [
      { label: '总体正确率', score: accuracy, evidence: `${correct}/${attempts || 0}` }
    ],
    weakPoints: weak,
    recommendations: attempts
      ? ['优先处理薄弱题型。', '对错误题进行二次练习。', '保持近期练习频率。']
      : ['先完成一次练习以积累学情数据。'],
    riskLevel: accuracy < 0.5 && attempts >= 5 ? 'high' : accuracy < 0.75 && attempts >= 5 ? 'medium' : 'low'
  };
}

async function persistAiArtifact(
  user: User,
  data: {
    artifactType: 'document_parse' | 'answer_generation' | 'learning_report';
    bankId?: number | null;
    questionId?: number | null;
    importJobId?: number | null;
    practiceSessionId?: number | null;
    inputPayload: unknown;
    outputPayload: unknown;
  }
) {
  await sql`
    INSERT INTO ai_artifacts (
      artifact_type, user_id, bank_id, question_id, import_job_id, practice_session_id,
      provider, model, input_payload, output_payload, status
    )
    VALUES (
      ${data.artifactType}, ${user.id}, ${data.bankId ?? null}, ${data.questionId ?? null},
      ${data.importJobId ?? null}, ${data.practiceSessionId ?? null},
      'mastra', ${getMastraModelName()}, ${sql.json(data.inputPayload as never)}, ${sql.json(data.outputPayload as never)}, 'completed'
    )
  `;
}
