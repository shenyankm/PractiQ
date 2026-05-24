import { SignJWT, jwtVerify } from 'jose';

export type SessionPayload = {
  user: { id: number };
  expires: string;
  jti?: string;
};

const secret = process.env.AUTH_SECRET || 'development-secret';
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
