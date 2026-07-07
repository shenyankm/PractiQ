import 'server-only';

import { sql } from '../db';
import { ApiError } from '../api';
import { invalidateUserCache } from '../auth';
import { requireAdminRole } from '../permissions';
import { redisIncr, redisKey } from '../redis';
import type { KnowledgePoint, User } from '../types';

export async function getAdminOverview(user: User) {
  requireAdminRole(user);

  const rows = await sql<Array<{
    total_users: number;
    active_users: number;
    admin_users: number;
    plus_users: number;
    total_banks: number;
    total_questions: number;
    import_jobs: number;
    open_review_items: number;
    knowledge_points: number;
  }>>`
    SELECT
      (SELECT COUNT(*)::int FROM users) AS total_users,
      (SELECT COUNT(*)::int FROM users WHERE is_active = true) AS active_users,
      (SELECT COUNT(*)::int FROM users WHERE role = 'admin') AS admin_users,
      (SELECT COUNT(*)::int FROM users WHERE membership IN ('plus', 'enterprise')) AS plus_users,
      (SELECT COUNT(*)::int FROM question_banks) AS total_banks,
      (SELECT COUNT(*)::int FROM questions) AS total_questions,
      (SELECT COUNT(*)::int FROM question_import_jobs) AS import_jobs,
      (SELECT COUNT(*)::int FROM question_import_job_review_items WHERE status = 'open') AS open_review_items,
      (SELECT COUNT(*)::int FROM knowledge_points) AS knowledge_points
  `;

  return rows[0];
}

export async function listAdminUsers(user: User, params?: URLSearchParams) {
  requireAdminRole(user);
  const q = params?.get('q')?.trim() || null;
  const status = params?.get('status') || 'all';
  const role = params?.get('role') || 'all';

  return sql<Array<User & {
    bank_count: number;
    import_job_count: number;
    practice_session_count: number;
  }>>`
    SELECT
      u.id, u.username, u.email, u.avatar_url, u.is_active, u.role, u.membership,
      u.plus_trial_ends_at, u.plus_expires_at, u.created_at, u.updated_at,
      COALESCE(bank_counts.bank_count, 0)::int AS bank_count,
      COALESCE(import_counts.import_job_count, 0)::int AS import_job_count,
      COALESCE(session_counts.practice_session_count, 0)::int AS practice_session_count
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*)::int AS bank_count
      FROM user_bank_links
      WHERE is_owner = true
      GROUP BY user_id
    ) bank_counts ON bank_counts.user_id = u.id
    LEFT JOIN (
      SELECT created_by, COUNT(*)::int AS import_job_count
      FROM question_import_jobs
      GROUP BY created_by
    ) import_counts ON import_counts.created_by = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*)::int AS practice_session_count
      FROM user_practice_sessions
      GROUP BY user_id
    ) session_counts ON session_counts.user_id = u.id
    WHERE
      (${q}::text IS NULL OR u.username ILIKE ${q ? `%${q}%` : null} OR u.email ILIKE ${q ? `%${q}%` : null})
      AND (${status} = 'all' OR (${status} = 'active' AND u.is_active = true) OR (${status} = 'inactive' AND u.is_active = false))
      AND (${role} = 'all' OR u.role = ${role})
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT 100
  `;
}

export async function listAdminKnowledgePoints(user: User, params?: URLSearchParams) {
  requireAdminRole(user);
  const subject = params?.get('subject') || null;
  const q = params?.get('q')?.trim() || null;

  return sql<KnowledgePoint[]>`
    SELECT id, subject_id, code, display_name, parent_id, metadata_json, created_at, updated_at
    FROM knowledge_points
    WHERE
      (${subject}::text IS NULL OR subject_id = ${subject})
      AND (${q}::text IS NULL OR code ILIKE ${q ? `%${q}%` : null} OR display_name ILIKE ${q ? `%${q}%` : null})
    ORDER BY subject_id, code
    LIMIT 200
  `;
}

export async function createKnowledgePoint(
  user: User,
  data: { subjectId: string; code: string; displayName: string; parentId?: number | null; metadata?: Record<string, unknown> }
) {
  requireAdminRole(user);
  const rows = await sql`
    INSERT INTO knowledge_points (subject_id, code, display_name, parent_id, metadata_json)
    VALUES (${data.subjectId}, ${data.code}, ${data.displayName}, ${data.parentId ?? null}, ${JSON.stringify(data.metadata ?? {})})
    RETURNING *
  `;
  await redisIncr(redisKey('cache-version', 'knowledge-points'));
  return rows[0];
}

export async function updateKnowledgePoint(
  user: User,
  id: number,
  data: { code?: string; displayName?: string; parentId?: number | null; metadata?: Record<string, unknown> }
) {
  requireAdminRole(user);
  const rows = await sql`
    UPDATE knowledge_points
    SET
      code = COALESCE(${data.code ?? null}, code),
      display_name = COALESCE(${data.displayName ?? null}, display_name),
      parent_id = COALESCE(${data.parentId ?? null}, parent_id),
      metadata_json = COALESCE(${data.metadata ? JSON.stringify(data.metadata) : null}, metadata_json)
    WHERE id = ${id}
    RETURNING *
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Knowledge point not found');
  await redisIncr(redisKey('cache-version', 'knowledge-points'));
  return rows[0];
}

export async function setUserStatus(user: User, targetUserId: number, isActive: boolean) {
  requireAdminRole(user);
  if (user.id === targetUserId && !isActive) {
    throw new ApiError(409, 'INVALID_STATE', 'Administrators cannot disable their own account');
  }
  const rows = await sql<User[]>`
    UPDATE users
    SET is_active = ${isActive}
    WHERE id = ${targetUserId}
    RETURNING id, username, email, avatar_url, is_active, role, membership, plus_trial_ends_at, plus_expires_at, created_at, updated_at
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  await invalidateUserCache(targetUserId);
  return rows[0];
}

export async function updateUserAccess(
  user: User,
  targetUserId: number,
  data: { role?: 'admin' | 'user'; membership?: 'free' | 'plus' | 'enterprise' }
) {
  requireAdminRole(user);
  if (user.id === targetUserId && data.role === 'user') {
    throw new ApiError(409, 'INVALID_STATE', 'Administrators cannot remove their own admin role');
  }

  const rows = await sql<User[]>`
    UPDATE users
    SET
      role = COALESCE(${data.role ?? null}, role),
      membership = COALESCE(${data.membership ?? null}, membership),
      plus_expires_at = CASE
        WHEN ${data.membership ?? null} = 'free' THEN NULL
        ELSE plus_expires_at
      END
    WHERE id = ${targetUserId}
    RETURNING id, username, email, avatar_url, is_active, role, membership, plus_trial_ends_at, plus_expires_at, created_at, updated_at
  `;
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  await invalidateUserCache(targetUserId);
  return rows[0];
}
