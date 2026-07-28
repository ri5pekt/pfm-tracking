import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SessionUser = {
  id: string;
  email: string;
  role: 'admin' | 'staff';
};

const COOKIE_NAME = 'pfm_admin_session';
const MAX_AGE_SEC = 60 * 60 * 12; // 12h

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createSessionCookie(user: SessionUser, secret: string): string {
  const body = Buffer.from(
    JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC }),
  ).toString('base64url');
  const sig = sign(body, secret);
  return `${body}.${sig}`;
}

export function readSessionCookie(value: string | undefined, secret: string): SessionUser | null {
  if (!value) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionUser & {
      exp: number;
    };
    if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    if (!parsed.id || !parsed.email || (parsed.role !== 'admin' && parsed.role !== 'staff')) {
      return null;
    }
    return { id: parsed.id, email: parsed.email, role: parsed.role };
  } catch {
    return null;
  }
}

export function setSession(reply: FastifyReply, user: SessionUser, secret: string): void {
  reply.setCookie(COOKIE_NAME, createSessionCookie(user, secret), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_SEC,
  });
}

export function clearSession(reply: FastifyReply): void {
  // Must match setSession attributes or the browser keeps the cookie.
  reply.clearCookie(COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

export function getSession(request: FastifyRequest, secret: string): SessionUser | null {
  return readSessionCookie(request.cookies[COOKIE_NAME], secret);
}

export { COOKIE_NAME };
