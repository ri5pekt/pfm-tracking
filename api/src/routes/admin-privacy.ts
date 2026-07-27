import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Env } from '../config.js';
import type { Db } from '../db/pool.js';
import { processDataErasure } from '../jobs/retention.js';
import { listUnmappedStatuses, runDailyReconcile } from '../jobs/reconcile.js';
import { writeAudit } from '../lib/audit.js';
import { getSession } from '../lib/session.js';

export async function registerAdminPrivacyRoutes(
  app: FastifyInstance,
  deps: { db: Db; env: Env },
): Promise<void> {
  const { db, env } = deps;

  app.get('/admin/unmapped-statuses', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    const items = await listUnmappedStatuses(db);
    return { items };
  });

  app.get('/admin/reconcile', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    return runDailyReconcile(db);
  });

  app.post('/admin/privacy/erasure', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });

    const parsed = z.object({ email: z.string().email() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const result = await processDataErasure(db, {
      email: parsed.data.email,
      requestedBy: user.id,
    });

    await writeAudit(db, {
      actorId: user.id,
      action: 'privacy.erasure',
      targetType: 'customer_email',
      targetId: parsed.data.email.toLowerCase(),
      metadata: result,
    });

    return result;
  });
}
