import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { env } from './env';

export type SessionPayload = {
  user: { id: number };
  expires: string;
  jti?: string;
};

const sessionPayloadSchema = z.object({
  user: z.object({
    id: z.number().int().positive()
  }),
  expires: z.string().datetime(),
  jti: z.string().optional()
});

function sessionSecret() {
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  if (env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET environment variable is required in production');
  }
  return 'development-secret';
}

const secret = sessionSecret();
const key = new TextEncoder().encode(secret);

export async function signSessionToken(payload: SessionPayload, expirationTime = '7 days') {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expirationTime)
    .sign(key);
}

export async function verifySessionToken(token: string) {
  const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
  return sessionPayloadSchema.parse(payload);
}
