'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { clearSession, comparePasswords, getUserPasswordByLogin, hashPassword, setSession } from '@/lib/openwook/auth';
import { sql } from '@/lib/openwook/db';
import { errorToLog, logger } from '@/lib/openwook/logger';
import { assertSameOriginFromHeaders } from '@/lib/openwook/server-action-origin';

export type ActionState = {
  error?: string;
  success?: string;
  email?: string;
  username?: string;
  password?: string;
};

const signInSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(8).max(100)
});

const signUpSchema = z.object({
  username: z.string().trim().min(2).max(32),
  email: z.string().email().optional().or(z.literal('')),
  password: z.string().min(8).max(100)
});

function safeRedirect(value: FormDataEntryValue | null) {
  const target = String(value || '/dashboard');
  if (!target.startsWith('/') || target.startsWith('//')) return '/dashboard';

  try {
    const url = new URL(target, 'https://openwook.local');
    if (url.origin !== 'https://openwook.local') return '/dashboard';
    return `${url.pathname}${url.search}${url.hash}` || '/dashboard';
  } catch {
    return '/dashboard';
  }
}

export async function signIn(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await assertSameOriginFromHeaders();
  const parsed = signInSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.errors[0].message };

  const found = await getUserPasswordByLogin(parsed.data.email);
  if (!found?.password || !(await comparePasswords(parsed.data.password, found.password))) {
    return {
      error: '用户名/邮箱或密码错误。',
      email: parsed.data.email
    };
  }

  await setSession(found.id);
  redirect(safeRedirect(formData.get('redirect')));
}

export async function signUp(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  await assertSameOriginFromHeaders();
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.errors[0].message };

  const passwordHash = await hashPassword(parsed.data.password);

  try {
    const rows = await sql<Array<{ id: number }>>`
      INSERT INTO users (username, email, password, role, membership, plus_trial_ends_at)
      VALUES (${parsed.data.username}, ${parsed.data.email || null}, ${passwordHash}, 'user', 'free', NOW() + INTERVAL '3 days')
      RETURNING id
    `;
    await setSession(rows[0].id);
  } catch (error) {
    logger.warn({ ...errorToLog(error), action: 'signUp' }, 'sign up failed');
    return {
      error: '账号创建失败，用户名或邮箱可能已存在。',
      email: parsed.data.email || '',
      username: parsed.data.username
    };
  }

  redirect(safeRedirect(formData.get('redirect')));
}

export async function signOut() {
  await assertSameOriginFromHeaders();
  await clearSession();
  redirect('/sign-in');
}

export async function updatePassword() {
  await assertSameOriginFromHeaders();
  return { error: '密码更新接口将在设置页接入。' };
}
