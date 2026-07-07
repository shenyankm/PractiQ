import 'server-only';

import { sql } from '../db';
import { env } from '../env';
import { hashKey, redisGetOrSetJson, redisKey } from '../redis';
import { cacheVersion } from './internal';
import { getBank } from './banks';
import { getImportJob } from './imports';
import type { User } from '../types';

export async function getAnalyticsSummary(user: User) {
  const version = await cacheVersion('analytics', user.id);
  return redisGetOrSetJson(
    redisKey('cache', 'analytics', 'user', user.id, version, 'summary'),
    Number(env.ANALYTICS_CACHE_TTL_SECONDS || 30),
    async () => {
      const rows = await sql<Array<{
        owned_banks: number;
        favorite_banks: number;
        attempts: number;
        correct: number;
        wrong: number;
        sessions: number;
        active_sessions: number;
        active_imports: number;
      }>>`
        SELECT
          (SELECT COUNT(*)::int FROM user_bank_links WHERE user_id = ${user.id} AND is_owner = true) AS owned_banks,
          (SELECT COUNT(*)::int FROM user_bank_links WHERE user_id = ${user.id} AND is_favorite = true) AS favorite_banks,
          COALESCE((SELECT SUM(attempt_count)::int FROM user_question_stats WHERE user_id = ${user.id}), 0) AS attempts,
          COALESCE((SELECT SUM(correct_count)::int FROM user_question_stats WHERE user_id = ${user.id}), 0) AS correct,
          COALESCE((SELECT SUM(wrong_count)::int FROM user_question_stats WHERE user_id = ${user.id}), 0) AS wrong,
          (SELECT COUNT(*)::int FROM user_practice_sessions WHERE user_id = ${user.id}) AS sessions,
          (SELECT COUNT(*)::int FROM user_practice_sessions WHERE user_id = ${user.id} AND status = 'active') AS active_sessions,
          (SELECT COUNT(*)::int FROM question_import_jobs WHERE created_by = ${user.id} AND status IN ('queued', 'processing')) AS active_imports
      `;
      const summary = rows[0];
      return {
        ...summary,
        accuracy: summary.attempts ? Math.round((summary.correct / summary.attempts) * 100) : 0
      };
    }
  );
}

export async function getBankAnalytics(user: User, bankId: number) {
  await getBank(user, bankId);
  const rows = await sql<Array<{ completed_count: number; wrong_count: number; practiced_users: number; answer_count: number }>>`
    SELECT
      COALESCE(SUM(completed_count), 0)::int AS completed_count,
      COALESCE(SUM(wrong_count), 0)::int AS wrong_count,
      COUNT(*)::int AS practiced_users,
      (
        SELECT COUNT(*)::int
        FROM user_question_answers
        WHERE bank_id = ${bankId}
      ) AS answer_count
    FROM user_bank_stats
    WHERE bank_id = ${bankId}
  `;
  return rows[0];
}

export async function getBankLeaderboard(user: User, bankId: number, limit = 20) {
  await getBank(user, bankId);
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const version = await cacheVersion('leaderboard', bankId);
  return redisGetOrSetJson(
    redisKey('cache', 'leaderboard', 'bank', bankId, version, hashKey({ limit: safeLimit })),
    Number(env.LEADERBOARD_CACHE_TTL_SECONDS || 60),
    () => sql`
      SELECT
        u.id AS user_id,
        u.username,
        ubs.completed_count,
        ubs.wrong_count,
        ubs.last_practiced_at,
        CASE
          WHEN ubs.completed_count > 0
          THEN ROUND(((ubs.completed_count - ubs.wrong_count)::numeric / ubs.completed_count) * 100, 2)
          ELSE 0
        END AS accuracy_percent
      FROM user_bank_stats ubs
      JOIN users u ON u.id = ubs.user_id
      WHERE ubs.bank_id = ${bankId}
      ORDER BY ubs.completed_count DESC, accuracy_percent DESC, ubs.last_practiced_at DESC NULLS LAST
      LIMIT ${safeLimit}
    `
  );
}

export async function getUserStatsSnapshot(user: User) {
  const version = await cacheVersion('analytics', user.id);
  return redisGetOrSetJson(
    redisKey('cache', 'analytics', 'user', user.id, version, 'snapshot'),
    Number(env.ANALYTICS_CACHE_TTL_SECONDS || 30),
    async () => {
      const [summary, recentSessions, weakQuestions] = await Promise.all([
        getAnalyticsSummary(user),
        sql`
          SELECT id, bank_id, session_type, status, question_count, answered_count, correct_count, wrong_count, started_at, completed_at
          FROM user_practice_sessions
          WHERE user_id = ${user.id}
          ORDER BY started_at DESC, id DESC
          LIMIT 10
        `,
        sql`
          SELECT
            uqs.question_id,
            uqs.attempt_count,
            uqs.correct_count,
            uqs.wrong_count,
            uqs.mastery_score,
            q.stem,
            q.question_type_id
          FROM user_question_stats uqs
          JOIN questions q ON q.id = uqs.question_id
          WHERE uqs.user_id = ${user.id}
            AND uqs.attempt_count > 0
          ORDER BY uqs.mastery_score ASC NULLS FIRST, uqs.wrong_count DESC, uqs.last_answered_at DESC NULLS LAST
          LIMIT 10
        `
      ]);
      return { summary, recentSessions, weakQuestions };
    }
  );
}

export async function getImportAnalytics(user: User, jobId: number) {
  const job = await getImportJob(user, jobId);
  const rows = await sql<Array<{ events: number; review_open: number; outputs: number }>>`
    SELECT
      (SELECT COUNT(*)::int FROM question_import_job_events WHERE job_id = ${jobId}) AS events,
      (SELECT COUNT(*)::int FROM question_import_job_review_items WHERE job_id = ${jobId} AND status = 'open') AS review_open,
      (SELECT COUNT(*)::int FROM question_import_job_outputs WHERE job_id = ${jobId}) AS outputs
  `;
  return {
    ...job,
    ...rows[0]
  };
}
