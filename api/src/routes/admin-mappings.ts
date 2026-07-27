import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Env } from '../config.js';
import type { Db } from '../db/pool.js';
import { writeAudit } from '../lib/audit.js';
import { getSession } from '../lib/session.js';

const INTERNAL = [
  'ORDER_RECEIVED',
  'PROCESSING',
  'LABEL_CREATED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'EXCEPTION',
  'DELIVERED',
  'RETURNED_TO_SENDER',
  'CANCELLED',
] as const;

const mappingBody = z.object({
  source: z.enum(['shipbob', 'trackingmore', 'system']),
  raw_status: z.string().min(1),
  raw_substatus_code: z.string().nullable().optional(),
  internal_status: z.enum(INTERNAL),
  status_rank: z.number().int().min(0).max(100),
  notes: z.string().nullable().optional(),
});

export async function registerAdminMappingRoutes(
  app: FastifyInstance,
  deps: { db: Db; env: Env },
): Promise<void> {
  const { db, env } = deps;

  app.get('/admin/status-mappings', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });

    const { rows } = await db.query(
      `SELECT id, source, raw_status, raw_substatus_code, internal_status, status_rank,
              notes, updated_by, updated_at
       FROM status_mappings
       ORDER BY source, raw_status, coalesce(raw_substatus_code, '')`,
    );
    return { items: rows, internalStatuses: INTERNAL };
  });

  app.post('/admin/status-mappings', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });

    const parsed = mappingBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const b = parsed.data;
    const sub = b.raw_substatus_code?.trim() || null;

    try {
      const { rows } = await db.query(
        `INSERT INTO status_mappings (
           source, raw_status, raw_substatus_code, internal_status, status_rank, notes, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, source, raw_status, raw_substatus_code, internal_status, status_rank, notes, updated_at`,
        [b.source, b.raw_status.trim(), sub, b.internal_status, b.status_rank, b.notes ?? null, user.id],
      );
      await writeAudit(db, {
        actorId: user.id,
        action: 'status_mapping.create',
        targetType: 'status_mappings',
        targetId: rows[0]?.id,
        metadata: b,
      });
      return { item: rows[0] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('status_mappings_lookup_uidx')) {
        return reply.code(409).send({ error: 'duplicate_mapping' });
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/admin/status-mappings/:id', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });

    const parsed = mappingBody.partial().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const b = parsed.data;

    const { rows } = await db.query(
      `UPDATE status_mappings SET
         source = COALESCE($2, source),
         raw_status = COALESCE($3, raw_status),
         raw_substatus_code = CASE WHEN $4::boolean THEN $5 ELSE raw_substatus_code END,
         internal_status = COALESCE($6, internal_status),
         status_rank = COALESCE($7, status_rank),
         notes = CASE WHEN $8::boolean THEN $9 ELSE notes END,
         updated_by = $10,
         updated_at = now()
       WHERE id = $1
       RETURNING id, source, raw_status, raw_substatus_code, internal_status, status_rank, notes, updated_at`,
      [
        request.params.id,
        b.source ?? null,
        b.raw_status?.trim() ?? null,
        b.raw_substatus_code !== undefined,
        b.raw_substatus_code === undefined
          ? null
          : b.raw_substatus_code?.trim() || null,
        b.internal_status ?? null,
        b.status_rank ?? null,
        b.notes !== undefined,
        b.notes ?? null,
        user.id,
      ],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });

    await writeAudit(db, {
      actorId: user.id,
      action: 'status_mapping.update',
      targetType: 'status_mappings',
      targetId: request.params.id,
      metadata: b,
    });
    return { item: rows[0] };
  });

  app.delete<{ Params: { id: string } }>('/admin/status-mappings/:id', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });

    const { rowCount } = await db.query(`DELETE FROM status_mappings WHERE id = $1`, [
      request.params.id,
    ]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });

    await writeAudit(db, {
      actorId: user.id,
      action: 'status_mapping.delete',
      targetType: 'status_mappings',
      targetId: request.params.id,
    });
    return { ok: true };
  });
}
