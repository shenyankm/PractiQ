import { SignJWT, jwtVerify } from 'jose';

export type SessionPayload = {
  user: { id: number };
  expires: string;
  jti?: string;
};

function sessionSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  if (process.env.NODE_ENV === 'production') {
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
  return payload as SessionPayload;
}
