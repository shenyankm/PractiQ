import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('API route structure', () => {
  it('keeps auth, billing, and public read endpoints out of the catch-all route', () => {
    const expectedRoutes = [
      'app/api/v1/auth/me/route.ts',
      'app/api/v1/auth/register/route.ts',
      'app/api/v1/auth/login/route.ts',
      'app/api/v1/auth/logout/route.ts',
      'app/api/v1/billing/checkout/route.ts',
      'app/api/v1/billing/summary/route.ts',
      'app/api/v1/billing/webhook/route.ts',
      'app/api/v1/subjects/route.ts',
      'app/api/v1/question-types/route.ts',
      'app/api/v1/knowledge-points/route.ts'
    ];

    expect(expectedRoutes.filter((route) => !existsSync(route))).toEqual([]);

    const catchAll = readFileSync('app/api/v1/[[...path]]/route.ts', 'utf8');
    expect(catchAll).not.toContain('auth/register');
    expect(catchAll).not.toContain('auth/login');
    expect(catchAll).not.toContain('auth/logout');
    expect(catchAll).not.toContain('auth/me');
    expect(catchAll).not.toContain('billing/checkout');
    expect(catchAll).not.toContain("path[0] === 'subjects'");
    expect(catchAll).not.toContain("path[0] === 'question-types'");
    expect(catchAll).not.toContain("path[0] === 'knowledge-points'");
  });

  it('requires the moved resource families to have dedicated route files', () => {
    const expectedRoutes = [
      'app/api/v1/banks/route.ts',
      'app/api/v1/banks/[bankId]/route.ts',
      'app/api/v1/questions/[questionId]/route.ts',
      'app/api/v1/groups/[groupId]/route.ts',
      'app/api/v1/practice-sessions/route.ts',
      'app/api/v1/practice-sessions/[sessionId]/route.ts',
      'app/api/v1/import-jobs/route.ts',
      'app/api/v1/import-jobs/[jobId]/route.ts',
      'app/api/v1/import-jobs/[jobId]/file/route.ts',
      'app/api/v1/media/[mediaId]/route.ts',
      'app/api/v1/analytics/me/summary/route.ts',
      'app/api/v1/analytics/me/snapshot/route.ts',
      'app/api/v1/analytics/banks/[bankId]/route.ts',
      'app/api/v1/analytics/banks/[bankId]/leaderboard/route.ts',
      'app/api/v1/analytics/imports/[jobId]/route.ts',
      'app/api/v1/ai/artifacts/route.ts',
      'app/api/v1/ai/parse-document/route.ts',
      'app/api/v1/ai/generate-answer/route.ts',
      'app/api/v1/ai/learning-report/route.ts',
      'app/api/v1/users/me/route.ts',
      'app/api/v1/users/[userId]/status/route.ts'
    ];

    expect(expectedRoutes.filter((route) => !existsSync(route))).toEqual([]);

    const catchAll = readFileSync('app/api/v1/[[...path]]/route.ts', 'utf8');
    const movedRouteMarkers = [
      "path[0] === 'banks'",
      "path[0] === 'questions'",
      "path[0] === 'groups'",
      "path[0] === 'practice-sessions'",
      "path[0] === 'import-jobs'",
      "path[0] === 'media'",
      "path[0] === 'analytics'",
      "path[0] === 'ai'",
      "path[0] === 'users'",
      "path.join('/') === 'analytics/me/summary'",
      "path.join('/') === 'analytics/me/snapshot'",
      "path.join('/') === 'users/me'"
    ];

    expect(movedRouteMarkers.filter((marker) => catchAll.includes(marker))).toEqual([]);
  });

  it('keeps import file uploads on a dedicated route so other import job handlers stay storage-free', () => {
    expect(existsSync('app/api/v1/import-jobs/[jobId]/file/route.ts')).toBe(true);

    const catchAll = readFileSync('app/api/v1/import-jobs/[jobId]/[...path]/route.ts', 'utf8');
    expect(catchAll).not.toContain("path[0] == 'file'");
    expect(catchAll).not.toContain('addImportJobUploadedFile');
  });

  it('removes the legacy user route in favor of versioned endpoints', () => {
    expect(existsSync('app/api/user/route.ts')).toBe(false);
  });
});
