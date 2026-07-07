import 'server-only';

import { sql } from '../db';
import { invalidateUserCache } from '../auth';
import { requirePlusEntitlement } from '../permissions';
import { getAnalyticsSummary } from './analytics';
import type { User } from '../types';

export async function updateCurrentUser(
  user: User,
  data: { username?: string; email?: string | null; passwordHash?: string | null; avatarUrl?: string | null }
) {
  const rows = await sql<User[]>`
    UPDATE users
    SET
      username = COALESCE(${data.username ?? null}, username),
      email = COALESCE(${data.email ?? null}, email),
      password_hash = COALESCE(${data.passwordHash ?? null}, password_hash),
      avatar_url = CASE
        WHEN ${data.avatarUrl === undefined} THEN avatar_url
        ELSE ${data.avatarUrl ?? null}
      END
    WHERE id = ${user.id}
    RETURNING id, username, email, avatar_url, is_active, role, membership, plus_trial_ends_at, plus_expires_at, created_at, updated_at
  `;
  await invalidateUserCache(user.id);
  return rows[0];
}

export async function exportUserSummaryPdf(user: User) {
  requirePlusEntitlement(user, 'PDF export');
  const summary = await getAnalyticsSummary(user);
  const lines = [
    'OpenWook User Summary',
    `User: ${user.username}`,
    `Role: ${user.role}`,
    `Membership: ${user.membership}`,
    `Plus trial ends: ${user.plus_trial_ends_at ?? 'none'}`,
    '',
    `Owned banks: ${summary.owned_banks}`,
    `Favorite banks: ${summary.favorite_banks}`,
    `Practice sessions: ${summary.sessions}`,
    `Active sessions: ${summary.active_sessions}`,
    `Answer attempts: ${summary.attempts}`,
    `Correct answers: ${summary.correct}`,
    `Wrong answers: ${summary.wrong}`,
    `Accuracy: ${summary.accuracy}%`,
    `Active imports: ${summary.active_imports}`,
    '',
    `Generated at: ${new Date().toISOString()}`
  ];
  return buildSimplePdf(lines);
}

function buildSimplePdf(lines: string[]) {
  const content = [
    'BT',
    '/F1 18 Tf',
    '72 760 Td',
    `(${escapePdfText(lines[0] ?? 'OpenWook Export')}) Tj`,
    '/F1 11 Tf',
    ...lines.slice(1).flatMap((line) => [
      '0 -18 Td',
      `(${escapePdfText(line)}) Tj`
    ]),
    'ET'
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

function escapePdfText(value: string) {
  return value
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}
