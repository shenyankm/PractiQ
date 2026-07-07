import 'server-only';

import { sql } from '../db';
import { ApiError } from '../api';
import { redisGetOrSetJson, redisKey } from '../redis';
import {
  cacheVersion,
  hasUsableAnswerPayloadForTest,
  invalidateBankCaches,
  invalidateQuestionCaches,
  parseJson,
  shortCacheTtl,
  validateQuestionPayloadForTest
} from './internal';
import { requireBankOwner } from './banks';
import { resolveQuestionTypeIdForSubject } from './reference';
import type { AnswerMode, Question, User } from '../types';

export async function getQuestion(user: User, questionId: number) {
  const version = await cacheVersion('question', questionId);
  const question = await redisGetOrSetJson<
    (Question & { options: unknown; answer_keys: unknown; content_blocks: unknown; media_links: unknown }) | null
  >(
    redisKey('cache', 'question', questionId, 'user', user.id, version),
    shortCacheTtl,
    async () => {
      const rows = await sql<Array<Question & { options: unknown; answer_keys: unknown; content_blocks: unknown; media_links: unknown }>>`
        SELECT
          q.*,
          COALESCE(
            (
              SELECT json_agg(qo.* ORDER BY qo.sort_order)
              FROM question_options qo
              WHERE qo.question_id = q.id
            ),
            '[]'
          ) AS options,
          COALESCE(
            (
              SELECT json_agg(qak.* ORDER BY qak.version)
              FROM question_answer_keys qak
              WHERE qak.question_id = q.id
            ),
            '[]'
          ) AS answer_keys,
          COALESCE(
            (
              SELECT json_agg(qcb.* ORDER BY qcb.sequence)
              FROM question_content_blocks qcb
              WHERE qcb.question_id = q.id
            ),
            '[]'
          ) AS content_blocks,
          COALESCE(
            (
              SELECT json_agg(qml.* ORDER BY qml.sort_order)
              FROM question_media_links qml
              WHERE qml.question_id = q.id
            ),
            '[]'
          ) AS media_links
        FROM questions q
        WHERE q.id = ${questionId}
          AND EXISTS (
            SELECT 1
            FROM bank_question_links bql
            JOIN question_banks b ON b.id = bql.bank_id
            LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = ${user.id}
            WHERE bql.question_id = q.id
              AND (b.is_public = true OR ubl.id IS NOT NULL)
          )
        LIMIT 1
      `;
      return rows[0] ?? null;
    }
  );
  if (!question) throw new ApiError(404, 'NOT_FOUND', 'Question not found');
  return question;
}

export async function createQuestion(
  user: User,
  bankId: number,
  data: {
    questionTypeId: string;
    answerMode: AnswerMode;
    stem: string;
    analysis?: string | null;
    choiceVariant?: 'single' | 'multiple' | null;
    status?: 'draft' | 'active' | 'archived';
    options?: Array<{ label: string; content: string; isCorrect?: boolean }>;
    answerPayload?: Record<string, unknown>;
  },
  options?: { invalidateCaches?: boolean; resolveQuestionType?: boolean }
) {
  const bank = await requireBankOwner(user, bankId);
  validateQuestionPayloadForTest(data);
  const questionTypeId = options?.resolveQuestionType === false
    ? data.questionTypeId
    : await resolveQuestionTypeIdForSubject(bank.subject, data.questionTypeId, data.answerMode);
  const question = await sql.begin(async (tx) => {
    await tx`SELECT id FROM question_banks WHERE id = ${bankId} FOR UPDATE`;
    const maxRows = await tx<Array<{ next_sort: number }>>`
      SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
      FROM bank_question_links
      WHERE bank_id = ${bankId}
    `;
    const created = await tx<Question[]>`
      INSERT INTO questions (
        subject_id, question_type_id, answer_mode, choice_variant, stem,
        analysis, status, source_type, imported_by
      )
      VALUES (
        ${bank.subject}, ${questionTypeId}, ${data.answerMode},
        ${data.choiceVariant ?? null}, ${data.stem}, ${data.analysis ?? null},
        ${data.status ?? 'draft'}, 'manual', ${user.id}
      )
      RETURNING *
    `;
    const question = created[0];

    await tx`
      INSERT INTO question_answer_keys (question_id, answer_mode, answer_payload)
      VALUES (${question.id}, ${data.answerMode}, ${JSON.stringify(data.answerPayload ?? {})})
    `;

    if (data.answerMode === 'choice') {
      await tx`INSERT INTO question_choice_details (question_id, selection_mode) VALUES (${question.id}, ${data.choiceVariant ?? 'single'})`;
      for (const [index, option] of (data.options ?? []).entries()) {
        await tx`
          INSERT INTO question_options (question_id, option_label, sort_order, content, is_correct)
          VALUES (${question.id}, ${option.label}, ${index + 1}, ${option.content}, ${option.isCorrect ?? false})
        `;
      }
    } else if (data.answerMode === 'true_false') {
      const answer = typeof data.answerPayload?.value === 'boolean' ? data.answerPayload.value : null;
      await tx`INSERT INTO question_true_false_details (question_id, correct_answer) VALUES (${question.id}, ${answer})`;
    } else if (data.answerMode === 'fill_blank') {
      await tx`INSERT INTO question_fill_blank_details (question_id, correct_answer) VALUES (${question.id}, ${JSON.stringify(data.answerPayload ?? {})})`;
    } else {
      const answer = typeof data.answerPayload?.value === 'string' ? data.answerPayload.value : null;
      await tx`INSERT INTO question_short_answer_details (question_id, correct_answer) VALUES (${question.id}, ${answer})`;
    }

    await tx`
      INSERT INTO bank_question_links (bank_id, question_id, sort_order, status, added_by)
      VALUES (${bankId}, ${question.id}, ${maxRows[0].next_sort}, ${data.status ?? 'draft'}, ${user.id})
    `;
    await tx`
      UPDATE question_banks
      SET total_count = total_count + 1
      WHERE id = ${bankId}
    `;
    return question;
  });
  if (options?.invalidateCaches !== false) await invalidateBankCaches(bankId, user.id);
  return question;
}

export async function updateQuestion(
  user: User,
  questionId: number,
  data: { stem?: string; analysis?: string | null; status?: string }
) {
  await ensureQuestionEditable(user, questionId);
  const status = normalizeQuestionStatus(data.status);
  if (status === 'active') await assertQuestionPublishable(user, questionId);
  const rows = await sql.begin(async (tx) => {
    const updated = await tx<Question[]>`
      UPDATE questions
      SET
        stem = COALESCE(${data.stem ?? null}, stem),
        analysis = COALESCE(${data.analysis ?? null}, analysis),
        status = COALESCE(${status ?? null}, status)
      WHERE id = ${questionId}
      RETURNING *
    `;
    if (status) {
      await tx`
        UPDATE bank_question_links
        SET status = ${status}
        WHERE question_id = ${questionId}
      `;
    }
    return updated;
  });
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

function normalizeQuestionStatus(status?: string | null) {
  if (!status) return null;
  if (status === 'draft' || status === 'active' || status === 'archived') return status;
  throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid question status');
}

export async function deleteQuestion(user: User, questionId: number) {
  await ensureQuestionEditable(user, questionId);
  const banks = await sql.begin(async (tx) => {
    const banks = await tx<Array<{ bank_id: number }>>`
      SELECT bank_id
      FROM bank_question_links
      WHERE question_id = ${questionId}
    `;
    await tx`DELETE FROM questions WHERE id = ${questionId}`;
    for (const bank of banks) {
      await tx`
        UPDATE question_banks
        SET total_count = GREATEST(total_count - 1, 0)
        WHERE id = ${bank.bank_id}
      `;
    }
    return banks;
  });
  await Promise.all(banks.map((bank) => invalidateBankCaches(bank.bank_id, user.id)));
  await invalidateQuestionCaches(questionId);
}

export async function setQuestionStatus(user: User, questionId: number, status: 'draft' | 'active' | 'archived') {
  if (status === 'active') await assertQuestionPublishable(user, questionId);
  await ensureQuestionEditable(user, questionId);
  const rows = await sql.begin(async (tx) => {
    const updated = await tx<Question[]>`
      UPDATE questions
      SET status = ${status}
      WHERE id = ${questionId}
      RETURNING *
    `;
    await tx`
      UPDATE bank_question_links
      SET status = ${status}
      WHERE question_id = ${questionId}
    `;
    return updated;
  });
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

async function assertQuestionPublishable(user: User, questionId: number) {
  await ensureQuestionEditable(user, questionId);
  const rows = await sql<Array<{ answer_mode: AnswerMode; option_count: number; correct_option_count: number; answer_key_count: number; answer_payload: string | null }>>`
    SELECT
      q.answer_mode,
      (SELECT COUNT(*)::int FROM question_options qo WHERE qo.question_id = q.id) AS option_count,
      (SELECT COUNT(*)::int FROM question_options qo WHERE qo.question_id = q.id AND qo.is_correct = true) AS correct_option_count,
      (SELECT COUNT(*)::int FROM question_answer_keys qak WHERE qak.question_id = q.id AND qak.is_primary = true) AS answer_key_count,
      (SELECT qak.answer_payload FROM question_answer_keys qak WHERE qak.question_id = q.id AND qak.is_primary = true LIMIT 1) AS answer_payload
    FROM questions q
    WHERE q.id = ${questionId}
    LIMIT 1
  `;
  const question = rows[0];
  if (!question || question.answer_key_count < 1) {
    throw new ApiError(409, 'INVALID_STATE', 'Question requires a primary answer key before publishing');
  }
  if (question.answer_mode === 'choice' && (question.option_count < 2 || question.correct_option_count < 1)) {
    throw new ApiError(409, 'INVALID_STATE', 'Choice question requires at least two options and one correct option');
  }
  if (!hasUsableAnswerPayloadForTest(question.answer_mode, parseJson(question.answer_payload ?? '{}') as Record<string, unknown> | undefined)) {
    throw new ApiError(409, 'INVALID_STATE', 'Question requires a usable primary answer payload before publishing');
  }
}

export async function upsertAnswerKey(
  user: User,
  questionId: number,
  data: {
    answerMode: AnswerMode;
    answerPayload: Record<string, unknown>;
    explanationPayload?: Record<string, unknown>;
    scorePayload?: Record<string, unknown>;
  }
) {
  await ensureQuestionEditable(user, questionId);
  const rows = await sql`
    INSERT INTO question_answer_keys (
      question_id, answer_mode, version, is_primary, answer_payload, explanation_payload, score_payload
    )
    VALUES (
      ${questionId}, ${data.answerMode}, 1, true, ${JSON.stringify(data.answerPayload)},
      ${JSON.stringify(data.explanationPayload ?? {})}, ${JSON.stringify(data.scorePayload ?? {})}
    )
    ON CONFLICT (question_id) WHERE is_primary
    DO UPDATE SET
      answer_mode = EXCLUDED.answer_mode,
      answer_payload = EXCLUDED.answer_payload,
      explanation_payload = EXCLUDED.explanation_payload,
      score_payload = EXCLUDED.score_payload
    RETURNING *
  `;
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

export async function createOption(
  user: User,
  questionId: number,
  data: { label: string; content: string; isCorrect?: boolean; sortOrder?: number }
) {
  await ensureQuestionEditable(user, questionId);
  const sortRows = await sql<Array<{ next_sort: number }>>`
    SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort
    FROM question_options
    WHERE question_id = ${questionId}
  `;
  const rows = await sql`
    INSERT INTO question_options (question_id, option_label, sort_order, content, is_correct)
    VALUES (${questionId}, ${data.label}, ${data.sortOrder ?? sortRows[0].next_sort}, ${data.content}, ${data.isCorrect ?? false})
    RETURNING *
  `;
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

export async function updateOption(
  user: User,
  questionId: number,
  optionId: number,
  data: { label?: string; content?: string; isCorrect?: boolean; sortOrder?: number }
) {
  await ensureQuestionEditable(user, questionId);
  const rows = await sql`
    UPDATE question_options
    SET
      option_label = COALESCE(${data.label ?? null}, option_label),
      content = COALESCE(${data.content ?? null}, content),
      is_correct = COALESCE(${data.isCorrect ?? null}, is_correct),
      sort_order = COALESCE(${data.sortOrder ?? null}, sort_order)
    WHERE id = ${optionId}
      AND question_id = ${questionId}
    RETURNING *
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Option not found');
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

export async function upsertQuestionMetadata(
  user: User,
  questionId: number,
  data: {
    difficultyLevel?: string | null;
    difficultyScore?: number | null;
    gradeLevel?: string | null;
    examType?: string | null;
    curriculumStandard?: string | null;
    textbookVersion?: string | null;
    knowledgeTags?: string[];
    skillTags?: string[];
    metadata?: Record<string, unknown>;
  }
) {
  await ensureQuestionEditable(user, questionId);
  const rows = await sql`
    INSERT INTO question_educational_metadata (
      question_id, difficulty_level, difficulty_score, grade_level, exam_type,
      curriculum_standard, textbook_version, knowledge_tags_json, skill_tags_json, metadata_json
    )
    VALUES (
      ${questionId}, ${data.difficultyLevel ?? null}, ${data.difficultyScore ?? null}, ${data.gradeLevel ?? null},
      ${data.examType ?? null}, ${data.curriculumStandard ?? null}, ${data.textbookVersion ?? null},
      ${JSON.stringify(data.knowledgeTags ?? [])}, ${JSON.stringify(data.skillTags ?? [])}, ${JSON.stringify(data.metadata ?? {})}
    )
    ON CONFLICT (question_id)
    DO UPDATE SET
      difficulty_level = EXCLUDED.difficulty_level,
      difficulty_score = EXCLUDED.difficulty_score,
      grade_level = EXCLUDED.grade_level,
      exam_type = EXCLUDED.exam_type,
      curriculum_standard = EXCLUDED.curriculum_standard,
      textbook_version = EXCLUDED.textbook_version,
      knowledge_tags_json = EXCLUDED.knowledge_tags_json,
      skill_tags_json = EXCLUDED.skill_tags_json,
      metadata_json = EXCLUDED.metadata_json
    RETURNING *
  `;
  await invalidateQuestionCaches(questionId);
  return rows[0];
}

export async function replaceQuestionKnowledgePoints(user: User, questionId: number, knowledgePointIds: number[]) {
  await ensureQuestionEditable(user, questionId);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM question_knowledge_point_links WHERE question_id = ${questionId}`;
    for (const knowledgePointId of knowledgePointIds) {
      await tx`
        INSERT INTO question_knowledge_point_links (question_id, knowledge_point_id, source_type)
        VALUES (${questionId}, ${knowledgePointId}, 'manual')
      `;
    }
  });
  await invalidateQuestionCaches(questionId);
}

export async function replaceQuestionContentBlocks(
  user: User,
  questionId: number,
  blocks: Array<{
    ownerKind?: string;
    role?: string | null;
    partType: string;
    sequence?: number;
    contentMode?: string | null;
    textFormat?: string | null;
    textValue?: string | null;
    latexValue?: string | null;
    mathmlValue?: string | null;
    htmlValue?: string | null;
    markdownValue?: string | null;
    jsonValue?: Record<string, unknown> | string | null;
    mediaId?: number | null;
  }>
) {
  await ensureQuestionEditable(user, questionId);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM question_content_blocks WHERE question_id = ${questionId}`;
    for (const [index, block] of blocks.entries()) {
      await tx`
        INSERT INTO question_content_blocks (
          question_id, owner_kind, role, part_type, sequence, content_mode, text_format,
          text_value, latex_value, mathml_value, html_value, markdown_value, json_value, media_id
        )
        VALUES (
          ${questionId}, ${block.ownerKind ?? 'question'}, ${block.role ?? null}, ${block.partType}, ${block.sequence ?? index + 1},
          ${block.contentMode ?? null}, ${block.textFormat ?? null}, ${block.textValue ?? null}, ${block.latexValue ?? null},
          ${block.mathmlValue ?? null}, ${block.htmlValue ?? null}, ${block.markdownValue ?? null},
          ${typeof block.jsonValue === 'string' ? block.jsonValue : block.jsonValue ? JSON.stringify(block.jsonValue) : null},
          ${block.mediaId ?? null}
        )
      `;
    }
  });
  await invalidateQuestionCaches(questionId);
}

export async function ensureQuestionEditable(user: User, questionId: number) {
  const rows = await sql<Array<{ id: number }>>`
    SELECT q.id
    FROM questions q
    JOIN bank_question_links bql ON bql.question_id = q.id
    JOIN user_bank_links ubl ON ubl.bank_id = bql.bank_id
    WHERE q.id = ${questionId}
      AND ubl.user_id = ${user.id}
      AND ubl.is_owner = true
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(403, 'FORBIDDEN', 'Question editor access required');
}
