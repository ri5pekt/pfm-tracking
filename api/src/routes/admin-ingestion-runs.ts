import type { FastifyInstance } from 'fastify';
import type { Env } from '../config.js';
import type { Db } from '../db/pool.js';
import { deriveIngestionSource } from '../lib/ingestion-run.js';
import { getSession } from '../lib/session.js';

function sourceJobFilter(source: string | undefined): string | null {
  if (!source || source === 'all') return null;
  if (source === 'shipbob') return 'shipbob.%';
  if (source === 'klb') return 'klb.%';
  if (source === 'trackingmore') return 'trackingmore.%';
  if (source === 'system') return null; // special: NOT like prefixes
  return null;
}

export async function registerAdminIngestionRunRoutes(
  app: FastifyInstance,
  deps: { db: Db; env: Env },
): Promise<void> {
  const { db, env } = deps;

  app.get('/admin/ingestion-runs', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });

    const q = request.query as {
      from?: string;
      to?: string;
      source?: string;
      status?: string;
      job_name?: string;
      page?: string;
      limit?: string;
    };

    const now = new Date();
    const from = q.from ? new Date(q.from) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const to = q.to ? new Date(q.to) : now;
    // Inclusive end-of-day if date-only
    if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) {
      to.setUTCHours(23, 59, 59, 999);
    }
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return reply.code(400).send({ error: 'invalid_date_range' });
    }

    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 100);
    const offset = (page - 1) * limit;

    const params: unknown[] = [from, to];
    const where: string[] = [`started_at >= $1`, `started_at <= $2`];

    if (q.status && ['running', 'success', 'partial', 'failed'].includes(q.status)) {
      params.push(q.status);
      where.push(`status = $${params.length}`);
    }
    if (q.job_name) {
      params.push(q.job_name);
      where.push(`job_name = $${params.length}`);
    }

    const source = q.source ?? 'all';
    if (source === 'system') {
      where.push(
        `job_name NOT LIKE 'shipbob.%' AND job_name NOT LIKE 'klb.%' AND job_name NOT LIKE 'trackingmore.%'`,
      );
    } else {
      const like = sourceJobFilter(source);
      if (like) {
        params.push(like);
        where.push(`job_name LIKE $${params.length}`);
      }
    }

    const whereSql = where.join(' AND ');

    const count = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ingestion_runs WHERE ${whereSql}`,
      params,
    );

    params.push(limit, offset);
    const { rows } = await db.query<{
      id: string;
      job_name: string;
      started_at: Date;
      finished_at: Date | null;
      status: string;
      records_seen: number;
      records_upserted: number;
      events_appended: number;
      cursor_before: Date | null;
      cursor_after: Date | null;
      item_count: string;
    }>(
      `SELECT r.id, r.job_name, r.started_at, r.finished_at, r.status,
              r.records_seen, r.records_upserted, r.events_appended,
              r.cursor_before, r.cursor_after,
              (SELECT count(*)::text FROM ingestion_run_items i WHERE i.run_id = r.id) AS item_count
       FROM ingestion_runs r
       WHERE ${whereSql}
       ORDER BY r.started_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      page,
      limit,
      total: Number(count.rows[0]?.n ?? 0),
      from: from.toISOString(),
      to: to.toISOString(),
      items: rows.map((r) => {
        const durationMs =
          r.finished_at && r.started_at
            ? Math.max(0, r.finished_at.getTime() - r.started_at.getTime())
            : null;
        return {
          id: r.id,
          jobName: r.job_name,
          source: deriveIngestionSource(r.job_name),
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          status: r.status,
          recordsSeen: r.records_seen,
          recordsUpserted: r.records_upserted,
          eventsAppended: r.events_appended,
          itemCount: Number(r.item_count),
          durationMs,
          cursorBefore: r.cursor_before,
          cursorAfter: r.cursor_after,
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/admin/ingestion-runs/:id', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });

    const q = request.query as {
      page?: string;
      limit?: string;
      action?: string;
      q?: string;
    };
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 200);
    const offset = (page - 1) * limit;

    const { rows: runs } = await db.query<{
      id: string;
      job_name: string;
      started_at: Date;
      finished_at: Date | null;
      status: string;
      records_seen: number;
      records_upserted: number;
      events_appended: number;
      errors: unknown;
      cursor_before: Date | null;
      cursor_after: Date | null;
    }>(
      `SELECT id, job_name, started_at, finished_at, status,
              records_seen, records_upserted, events_appended, errors,
              cursor_before, cursor_after
       FROM ingestion_runs WHERE id = $1`,
      [request.params.id],
    );
    const run = runs[0];
    if (!run) return reply.code(404).send({ error: 'not_found' });

    const actionCounts = await db.query<{ action: string; n: string }>(
      `SELECT action, count(*)::text AS n
       FROM ingestion_run_items WHERE run_id = $1
       GROUP BY action ORDER BY action`,
      [request.params.id],
    );

    const params: unknown[] = [request.params.id];
    const where = [`run_id = $1`];
    if (q.action && ['created', 'updated', 'unchanged', 'skipped', 'error'].includes(q.action)) {
      params.push(q.action);
      where.push(`action = $${params.length}`);
    }
    if (q.q?.trim()) {
      params.push(`%${q.q.trim()}%`);
      where.push(
        `(order_number ILIKE $${params.length} OR tracking_number ILIKE $${params.length} OR external_id ILIKE $${params.length} OR coalesce(detail,'') ILIKE $${params.length})`,
      );
    }
    const whereSql = where.join(' AND ');

    const itemCount = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ingestion_run_items WHERE ${whereSql}`,
      params,
    );

    params.push(limit, offset);
    const items = await db.query<{
      id: string;
      order_number: string | null;
      order_id: string | null;
      shipment_id: string | null;
      tracking_number: string | null;
      external_id: string | null;
      action: string;
      detail: string | null;
      created_at: Date;
    }>(
      `SELECT id, order_number, order_id, shipment_id, tracking_number, external_id,
              action, detail, created_at
       FROM ingestion_run_items
       WHERE ${whereSql}
       ORDER BY created_at ASC, id ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const durationMs =
      run.finished_at && run.started_at
        ? Math.max(0, run.finished_at.getTime() - run.started_at.getTime())
        : null;

    return {
      run: {
        id: run.id,
        jobName: run.job_name,
        source: deriveIngestionSource(run.job_name),
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        status: run.status,
        recordsSeen: run.records_seen,
        recordsUpserted: run.records_upserted,
        eventsAppended: run.events_appended,
        errors: run.errors,
        durationMs,
        cursorBefore: run.cursor_before,
        cursorAfter: run.cursor_after,
      },
      actionCounts: Object.fromEntries(
        actionCounts.rows.map((r) => [r.action, Number(r.n)]),
      ) as Record<string, number>,
      items: {
        page,
        limit,
        total: Number(itemCount.rows[0]?.n ?? 0),
        rows: items.rows.map((i) => ({
          id: i.id,
          orderNumber: i.order_number,
          orderId: i.order_id,
          shipmentId: i.shipment_id,
          trackingNumber: i.tracking_number,
          externalId: i.external_id,
          action: i.action,
          detail: i.detail,
          createdAt: i.created_at,
        })),
      },
    };
  });
}
