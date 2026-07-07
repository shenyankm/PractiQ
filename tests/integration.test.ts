import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/bcrypt';
import { sql } from '@/lib/openwook/db';
import { ApiError } from '@/lib/openwook/api';
import { redisDelByPattern, redisKey } from '@/lib/openwook/redis';
import { addImportJobUploadedFile } from '@/lib/openwook/services/imports-upload';
import {
  addImportJobFile,
  createBank,
  createImportJob,
  createQuestion,
  getBankPracticeSummary,
  getBankWrongQuestionCount,
  getImportJob,
  getPracticeQuestionPage,
  getPracticeQuestions,
  getPracticeSession,
  listImportJobChildren,
  resolveQuestionTypeIdForSubject,
  search,
  setQuestionStatus,
  startPracticeSession,
  submitAnswer,
  updateImportJobStatus
} from '@/lib/openwook/services';
import { generateLearningReportWithMastra, parseImportJobWithMastra } from '@/lib/openwook/ai';
import type { User } from '@/lib/openwook/types';

const runIntegration = process.env.OPENWOOK_SKIP_DB_TESTS !== '1';
const describeIntegration = runIntegration ? describe : describe.skip;

const unique = `vt${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
const users: User[] = [];
const bankIds: number[] = [];

async function createTestUser(suffix: string, overrides: Partial<User> = {}) {
  const password = await hash('openwook123', 4);
  const rows = await sql<User[]>`
    INSERT INTO users (username, email, password_hash, role, membership, plus_trial_ends_at, plus_expires_at)
    VALUES (
      ${`${unique}_${suffix}`},
      ${`${unique}_${suffix}@example.test`},
      ${password},
      ${overrides.role ?? 'user'},
      ${overrides.membership ?? 'plus'},
      ${overrides.plus_trial_ends_at === undefined ? sql`NOW() + INTERVAL '1 day'` : overrides.plus_trial_ends_at},
      ${overrides.plus_expires_at ?? null}
    )
    RETURNING id, username, email, avatar_url, is_active, role, membership, plus_trial_ends_at, plus_expires_at, created_at, updated_at
  `;
  users.push(rows[0]);
  return rows[0];
}

beforeAll(async () => {
  if (!runIntegration) return;
  await sql`SELECT 1`;
});

afterAll(async () => {
  if (!runIntegration) return;
  await redisDelByPattern(redisKey('*', unique, '*'));
  if (bankIds.length) {
    await sql`DELETE FROM question_banks WHERE id = ANY(${sql.array(bankIds)}::bigint[])`;
  }
  if (users.length) {
    await sql`DELETE FROM questions WHERE imported_by = ANY(${sql.array(users.map((user) => user.id))}::bigint[])`;
    await sql`DELETE FROM question_import_jobs WHERE created_by = ANY(${sql.array(users.map((user) => user.id))}::bigint[])`;
    await sql`DELETE FROM ai_artifacts WHERE user_id = ANY(${sql.array(users.map((user) => user.id))}::bigint[])`;
    await sql`DELETE FROM users WHERE id = ANY(${sql.array(users.map((user) => user.id))}::bigint[])`;
  }
  await sql.end({ timeout: 1 }).catch(() => {});
});

describeIntegration('OpenWook database integration', () => {
  it('normalizes subject question types, syncs publish status, and supports all/by-type/exam/wrong practice', async () => {
    const user = await createTestUser('practice');
    const bank = await createBank(user, {
      name: `${unique} Math Bank`,
      subject: 'math',
      isPublic: false
    });
    bankIds.push(bank.id);

    const mathType = await resolveQuestionTypeIdForSubject('math', 'generic_answer_mode', 'choice');
    expect(mathType).not.toBe('generic_answer_mode');

    const questionA = await createQuestion(user, bank.id, {
      questionTypeId: 'generic_answer_mode',
      answerMode: 'choice',
      stem: '1 + 1 = ?',
      status: 'draft',
      choiceVariant: 'single',
      options: [
        { label: 'A', content: '2', isCorrect: true },
        { label: 'B', content: '3', isCorrect: false }
      ],
      answerPayload: { selected: ['A'] }
    });
    const questionB = await createQuestion(user, bank.id, {
      questionTypeId: mathType,
      answerMode: 'true_false',
      stem: '2 + 2 = 5',
      status: 'draft',
      answerPayload: { value: false }
    });

    await setQuestionStatus(user, questionA.id, 'active');
    await setQuestionStatus(user, questionB.id, 'active');

    const summary = await getBankPracticeSummary(user, bank.id);
    expect(summary.activeCount).toBe(2);
    expect(Object.values(summary.typeCounts).reduce((total, count) => total + count, 0)).toBe(2);
    expect(summary.modeCounts.choice).toBe(1);
    expect(summary.modeCounts.true_false).toBe(1);
    expect(summary.wrongCount).toBe(0);

    const linkedRows = await sql<Array<{ question_id: number; question_status: string; link_status: string; question_type_id: string }>>`
      SELECT q.id AS question_id, q.status AS question_status, bql.status AS link_status, q.question_type_id
      FROM questions q
      JOIN bank_question_links bql ON bql.question_id = q.id
      WHERE q.id IN (${questionA.id}, ${questionB.id})
      ORDER BY q.id
    `;
    expect(linkedRows.every((row) => row.question_status === 'active' && row.link_status === 'active')).toBe(true);
    expect(linkedRows.every((row) => row.question_type_id !== 'generic_answer_mode')).toBe(true);

    const allSession = await startPracticeSession(user, {
      bankId: bank.id,
      mode: 'all',
      allQuestions: true
    });
    const allQuestions = await getPracticeQuestions(user, allSession.id);
    expect(allQuestions.map((question) => Number(question.question_id)).sort()).toEqual([Number(questionA.id), Number(questionB.id)].sort());
    const firstPage = await getPracticeQuestionPage(user, allSession.id, new URLSearchParams({ index: '0' }));
    expect(firstPage.question?.question_id).toBeTruthy();
    expect(firstPage.progress.length).toBe(2);
    expect(firstPage.total).toBe(2);
    expect(firstPage.answeredCount).toBe(0);
    expect(firstPage.progressTruncated).toBe(false);
    const searchResults = await search(user, 'questions', new URLSearchParams({ bankId: String(bank.id), q: '1 + 1' })) as unknown as Array<{ id: number; stem: string }>;
    expect(searchResults.some((question) => Number(question.id) === Number(questionA.id))).toBe(true);

    const typeSession = await startPracticeSession(user, {
      bankId: bank.id,
      mode: 'by_type',
      questionTypeId: linkedRows[0].question_type_id,
      questionCount: 10
    });
    const typeQuestions = await getPracticeQuestions(user, typeSession.id);
    expect(typeQuestions.length).toBeGreaterThan(0);
    expect(typeQuestions.every((question) => question.question_type_id === linkedRows[0].question_type_id)).toBe(true);

    const examSession = await startPracticeSession(user, {
      bankId: bank.id,
      mode: 'exam',
      questionCount: 2
    });
    const loadedExam = await getPracticeSession(user, examSession.id);
    expect(loadedExam.session_type).toBe('exam');

    await submitAnswer(user, allSession.id, {
      questionId: questionA.id,
      answerPayload: { selected: ['B'] },
      durationMs: 1000
    });
    await expect(submitAnswer(user, allSession.id, {
      questionId: questionB.id,
      answerPayload: {},
      durationMs: 1000
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(await getBankWrongQuestionCount(user, bank.id)).toBe(1);
    const wrongSummary = await getBankPracticeSummary(user, bank.id);
    expect(wrongSummary.wrongCount).toBe(1);
    const wrongSession = await startPracticeSession(user, {
      bankId: bank.id,
      mode: 'wrong',
      questionCount: 10
    });
    const wrongQuestions = await getPracticeQuestions(user, wrongSession.id);
    expect(wrongQuestions.map((question) => Number(question.question_id))).toEqual([Number(questionA.id)]);
  });

  it('requires source artifacts before queueing import jobs and persists fallback parsed TXT questions', async () => {
    const user = await createTestUser('import');
    const bank = await createBank(user, {
      name: `${unique} Import Bank`,
      subject: 'general',
      isPublic: false
    });
    bankIds.push(bank.id);

    const emptyJob = await createImportJob(user, {
      bankId: bank.id,
      fileName: 'empty.txt',
      sourceType: 'txt'
    });
    await expect(updateImportJobStatus(user, emptyJob.id, 'start')).rejects.toMatchObject({ code: 'SOURCE_FILE_REQUIRED' });

    const job = await createImportJob(user, {
      bankId: bank.id,
      fileName: 'questions.txt',
      sourceType: 'txt'
    });
    await addImportJobFile(user, job.id, {
      storagePath: 'oss://openwook/vitest/questions.txt',
      content: {
        text: '1. What is 2+2?\\nA. 4\\nB. 5\\n答案: A'
      },
      sourceType: 'txt'
    });

    const parsed = await parseImportJobWithMastra(user, job.id, { persistQuestions: true });
    expect(parsed.questions.length).toBe(1);

    const completed = await getImportJob(user, job.id);
    expect(completed.status).toBe('completed');
    expect(completed.imported_questions).toBe(1);

    const outputs = await listImportJobChildren(user, job.id, 'outputs') as unknown as Array<{ question_id: number | null }>;
    expect(outputs.length).toBe(1);
    expect(outputs[0].question_id).toBeTruthy();
  });

  it('stores uploaded TXT files as import artifacts with extracted text content', async () => {
    const user = await createTestUser('upload');
    const bank = await createBank(user, {
      name: `${unique} Upload Bank`,
      subject: 'general',
      isPublic: false
    });
    bankIds.push(bank.id);
    const job = await createImportJob(user, {
      bankId: bank.id,
      fileName: 'upload.txt',
      sourceType: 'txt'
    });

    const file = new File(['\uFEFF1. Uploaded question\n答案: example'], 'upload.txt', { type: 'text/plain' });
    const artifact = await addImportJobUploadedFile(user, job.id, file) as { content_json: string; storage_path: string };
    const content = JSON.parse(artifact.content_json) as { text: string; sourceType: string; sizeBytes: number };

    expect(artifact.storage_path).toContain('imports/');
    expect(content.sourceType).toBe('txt');
    expect(content.text).toContain('Uploaded question');
    expect(content.text.startsWith('\uFEFF')).toBe(false);
    expect(content.sizeBytes).toBeGreaterThan(0);
  });

  it('blocks learning report generation for other users unless requester is admin', async () => {
    const owner = await createTestUser('owner');
    const other = await createTestUser('other');
    const admin = await createTestUser('admin', { role: 'admin' });

    await expect(generateLearningReportWithMastra(owner, {
      userId: other.id,
      scope: 'individual'
    })).rejects.toThrow(/Administrator privileges required/);

    const report = await generateLearningReportWithMastra(admin, {
      userId: other.id,
      scope: 'individual'
    });
    expect(report.summary.length).toBeGreaterThan(0);
  });

  it('rejects DOCX imports for non-Plus users', async () => {
    const freeUser = await createTestUser('free', { membership: 'free', plus_trial_ends_at: '2000-01-01T00:00:00.000Z' as never });
    await expect(createImportJob(freeUser, {
      fileName: 'questions.docx',
      sourceType: 'docx'
    })).rejects.toBeInstanceOf(ApiError);
  });
});
