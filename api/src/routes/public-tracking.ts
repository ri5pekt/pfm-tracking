import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Env } from '../config.js';
import type { Db } from '../db/pool.js';
import {
  getPublicTrackingByToken,
  lookupPublicTracking,
  type PublicTrackingPayload,
} from '../domain/public-tracking.js';

type Deps = { db: Db; env: Env };

const lookupBody = z
  .object({
    orderNumber: z.string().min(1),
    email: z.string().email().optional(),
    postcode: z.string().min(2).optional(),
  })
  .refine((b) => Boolean(b.email || b.postcode), {
    message: 'email_or_postcode_required',
  });

type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();

function clientIp(request: { ip: string; headers: Record<string, unknown> }): string {
  const xf = request.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0]!.trim();
  return request.ip || 'unknown';
}

function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

function wantsHtml(request: { headers: Record<string, unknown> }): boolean {
  const accept = String(request.headers.accept ?? '');
  if (accept.includes('application/json') && !accept.includes('text/html')) return false;
  return accept.includes('text/html') || accept === '' || accept.includes('*/*');
}

function loadTemplate(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '../public/tracking-page.html'),
    path.join(here, '../../src/public/tracking-page.html'),
  ];
  for (const candidate of candidates) {
    try {
      // Always read from disk so HTML edits show up without an API restart.
      return readFileSync(candidate, 'utf8');
    } catch {
      /* try next */
    }
  }
  throw new Error('tracking-page.html not found');
}

function renderTrackingPage(data: PublicTrackingPayload | null, mode: 'track' | 'lookup'): string {
  const html = loadTemplate();
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  return html
    .replace('__PFM_MODE__', mode)
    .replace('__PFM_PAYLOAD__', payload)
    .replace('__PFM_ERROR__', data ? 'null' : JSON.stringify('not_found'));
}

function renderLookupPage(error: string | null = null): string {
  const html = loadTemplate();
  return html
    .replace('__PFM_MODE__', 'lookup')
    .replace('__PFM_PAYLOAD__', 'null')
    .replace('__PFM_ERROR__', error ? JSON.stringify(error) : 'null');
}

export async function registerPublicTrackingRoutes(
  app: FastifyInstance,
  deps: Deps,
): Promise<void> {
  const { db, env } = deps;

  app.get<{ Params: { token: string } }>('/t/:token', async (request, reply) => {
    const ip = clientIp(request);
    if (!rateLimit(`t:${ip}`, 120, 60_000)) {
      return reply.code(429).send({ error: 'rate_limited' });
    }

    const token = request.params.token?.trim();
    if (!token || token.length < 16) {
      if (wantsHtml(request)) {
        reply.type('text/html').code(404);
        return renderTrackingPage(null, 'track');
      }
      return reply.code(404).send({ error: 'not_found' });
    }

    const payload = await getPublicTrackingByToken(db, token);
    if (!payload) {
      if (wantsHtml(request)) {
        reply.type('text/html').code(404);
        return renderTrackingPage(null, 'track');
      }
      return reply.code(404).send({ error: 'not_found' });
    }

    if (wantsHtml(request)) {
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      reply.type('text/html');
      return renderTrackingPage(payload, 'track');
    }
    return payload;
  });

  app.get('/lookup', async (request, reply) => {
    const ip = clientIp(request);
    if (!rateLimit(`lookup-get:${ip}`, 60, 60_000)) {
      return reply.code(429).type('text/html').send('<h1>Too many requests</h1>');
    }
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.type('text/html');
    return renderLookupPage();
  });

  app.post('/lookup', async (request, reply) => {
    const ip = clientIp(request);
    if (!rateLimit(`lookup:${ip}`, 20, 60_000)) {
      return reply.code(429).send({ error: 'rate_limited' });
    }

    const parsed = lookupBody.safeParse(request.body);
    if (!parsed.success) {
      // Generic failure — do not reveal validation specifics that help enumeration
      return reply.code(404).send({ error: 'not_found' });
    }

    const result = await lookupPublicTracking(db, {
      orderNumber: parsed.data.orderNumber,
      email: parsed.data.email,
      postcode: parsed.data.postcode,
      tokenSecret: env.ADMIN_SESSION_SECRET,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    });

    if (!result) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return {
      trackingUrl: result.trackingUrl,
      order: result.payload,
    };
  });

  /**
   * Legacy / lost-link bridge for Phase 4 cutover.
   * GET /go?order=123&email=a@b.com  (or &postcode=…) → 302 to /t/:token
   * Generic failure page — does not reveal whether the order exists.
   */
  app.get('/go', async (request, reply) => {
    const ip = clientIp(request);
    if (!rateLimit(`go:${ip}`, 20, 60_000)) {
      return reply.code(429).type('text/html').send('<h1>Too many requests</h1>');
    }

    const q = request.query as {
      order?: string;
      orderNumber?: string;
      email?: string;
      postcode?: string;
    };
    const orderNumber = (q.order ?? q.orderNumber ?? '').trim();
    const email = q.email?.trim();
    const postcode = q.postcode?.trim();

    if (!orderNumber || (!email && !postcode)) {
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      reply.type('text/html').code(400);
      return renderLookupPage('Enter order number plus email or postcode.');
    }

    const result = await lookupPublicTracking(db, {
      orderNumber,
      email,
      postcode,
      tokenSecret: env.ADMIN_SESSION_SECRET,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    });

    if (!result) {
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      reply.type('text/html').code(404);
      return renderLookupPage('not_found');
    }

    return reply.redirect(result.trackingUrl);
  });
}
