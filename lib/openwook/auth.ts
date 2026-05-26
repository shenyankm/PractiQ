import 'server-only';

import { randomUUID } from 'node:crypto';
import { compare, hash } from '@node-rs/bcrypt';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { sql } from './db';
import { ApiError } from './api';
import { signSessionToken, verifySessionToken, type SessionPayload } from './session';
import { redisDel, redisGetJson, redisGetOrSetJson, redisKey, redisSetJson } from './redis';
import type { User } from './types';

const saltRounds = 10;

export async function hashPassword(password: string) {
  return hash(password, saltRounds);
}

export async function comparePasswords(password: string, passwordHash: string) {
  return compare(password, passwordHash);
}

export async function signToken(payload: SessionPayload) {
  return signSessionToken(payload);
}

export async function verifyToken(token: string) {
  return verifySessionToken(token);
}

export async function setSession(userId: number) {
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const token = await signToken({
    user: { id: userId },
    expires: expires.toISOString(),
    jti: randomUUID()
  });

  (await cookies()).set('session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires,
    path: '/'
  });
}

export async function clearSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get('session')?.value;
  if (token) {
    try {
      const session = await verifyToken(token);
      const ttlSeconds = Math.max(0, Math.ceil((new Date(session.expires).getTime() - Date.now()) / 1000));
      if (session.jti && ttlSeconds > 0) {
        await redisSetJson(redisKey('session', 'revoked', session.jti), true, ttlSeconds);
      }
    } catch {
      // Invalid tokens are removed below.
    }
  }
  cookieStore.delete('session');
}

export async function getCurrentUser(): Promise<User | null> {
  const token = (await cookies()).get('session')?.value;
  if (!token) return null;

  return getUserForSessionToken(token);
}

const getUserForSessionToken = cache(async (token: string): Promise<User | null> => {
  try {
    const session = await verifyToken(token);
    if (new Date(session.expires) < new Date()) return null;
    if (session.jti && await redisGetJson<boolean>(redisKey('session', 'revoked', session.jti))) {
      return null;
    }

    return await redisGetOrSetJson<User | null>(
      userCacheKey(session.user.id),
      Number(process.env.USER_CACHE_TTL_SECONDS || 60),
      async () => {
        const rows = await sql<User[]>`
          SELECT id, username, email, avatar_url, is_active, role, membership, plus_trial_ends_at, plus_expires_at, created_at, updated_at
          FROM users
          WHERE id = ${session.user.id}
          LIMIT 1
        `;
        return rows[0] ?? null;
      }
    );
  } catch {
    return null;
  }
});

export function userCacheKey(userId: number) {
  return redisKey('cache', 'user', userId);
}

export async function invalidateUserCache(userId: number) {
  await redisDel(userCacheKey(userId));
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  if (!user.is_active) {
    throw new ApiError(403, 'USER_INACTIVE', 'User account is disabled');
  }
  return user;
}

export async function getUserPasswordByLogin(login: string) {
  const rows = await sql<Array<{ id: number; password: string | null }>>`
    SELECT id, password
    FROM users
    WHERE lower(username) = lower(${login})
       OR lower(email) = lower(${login})
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getUserPasswordById(userId: number) {
  const rows = await sql<Array<{ id: number; password: string | null }>>`
    SELECT id, password
    FROM users
    WHERE id = ${userId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
