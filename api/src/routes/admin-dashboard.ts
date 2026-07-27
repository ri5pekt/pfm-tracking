import type { FastifyInstance } from 'fastify';
import type { Env } from '../config.js';
import type { Db } from '../db/pool.js';
import { collectOpsHealth } from '../jobs/ops-health.js';
import { runDailyReconcile } from '../jobs/reconcile.js';
import { getSession } from '../lib/session.js';

export async function registerAdminDashboardRoutes(
  app: FastifyInstance,
  deps: { db: Db; env: Env },
): Promise<void> {
  const { db, env } = deps;

  app.get('/admin/dashboard', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });

    const counts = await db.query<{
      all: string;
      exception: string;
      stalled: string;
      out_for_delivery: string;
      in_transit: string;
      delivered: string;
      cancelled: string;
    }>(
      `SELECT
         count(*)::text AS all,
         count(*) FILTER (WHERE internal_status = 'EXCEPTION')::text AS exception,
         count(*) FILTER (WHERE is_stalled)::text AS stalled,
         count(*) FILTER (WHERE internal_status = 'OUT_FOR_DELIVERY')::text AS out_for_delivery,
         count(*) FILTER (WHERE internal_status = 'IN_TRANSIT')::text AS in_transit,
         count(*) FILTER (WHERE internal_status = 'DELIVERED')::text AS delivered,
         count(*) FILTER (WHERE internal_status = 'CANCELLED')::text AS cancelled
       FROM shipments`,
    );

    const bySource = await db.query<{ source: string; n: string }>(
      `SELECT source, count(*)::text AS n FROM shipments GROUP BY 1 ORDER BY 1`,
    );

    const cursors = await db.query<{
      job_name: string;
      cursor_at: Date | null;
      last_success_at: Date | null;
      updated_at: Date;
    }>(`SELECT job_name, cursor_at, last_success_at, updated_at FROM sync_cursors ORDER BY job_name`);

    const recentRuns = await db.query<{
      id: string;
      job_name: string;
      started_at: Date;
      finished_at: Date | null;
      status: string;
      records_seen: number;
      records_upserted: number;
      events_appended: number;
    }>(
      `SELECT id, job_name, started_at, finished_at, status,
              records_seen, records_upserted, events_appended
       FROM ingestion_runs
       ORDER BY started_at DESC
       LIMIT 20`,
    );

    const notifications = await db.query<{ event_type: string; status: string; n: string }>(
      `SELECT event_type, status, count(*)::text AS n
       FROM notification_log
       GROUP BY 1, 2
       ORDER BY 1, 2`,
    );

    const unmapped = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tracking_events te
       WHERE te.raw_status IS NOT NULL
         AND te.received_at > now() - interval '14 days'
         AND NOT EXISTS (
           SELECT 1 FROM status_mappings sm
           WHERE sm.source = te.source
             AND sm.raw_status = te.raw_status
             AND (
               sm.raw_substatus_code IS NULL
               OR sm.raw_substatus_code = ''
               OR sm.raw_substatus_code = te.raw_substatus_code
             )
         )`,
    );

    const reconcile = await runDailyReconcile(db);
    const opsHealth = await collectOpsHealth(db);

    return {
      counts: {
        all: Number(counts.rows[0]?.all ?? 0),
        exception: Number(counts.rows[0]?.exception ?? 0),
        stalled: Number(counts.rows[0]?.stalled ?? 0),
        out_for_delivery: Number(counts.rows[0]?.out_for_delivery ?? 0),
        in_transit: Number(counts.rows[0]?.in_transit ?? 0),
        delivered: Number(counts.rows[0]?.delivered ?? 0),
        cancelled: Number(counts.rows[0]?.cancelled ?? 0),
      },
      bySource: bySource.rows.map((r) => ({ source: r.source, n: Number(r.n) })),
      cursors: cursors.rows,
      recentRuns: recentRuns.rows,
      notifications: notifications.rows.map((r) => ({
        eventType: r.event_type,
        status: r.status,
        n: Number(r.n),
      })),
      unmappedRecentEvents: Number(unmapped.rows[0]?.n ?? 0),
      reconcile,
      opsHealth,
    };
  });
}
