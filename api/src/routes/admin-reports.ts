import type { FastifyInstance } from 'fastify';
import type { Env } from '../config.js';
import type { Db } from '../db/pool.js';
import { getSession } from '../lib/session.js';

export async function registerAdminReportRoutes(
  app: FastifyInstance,
  deps: { db: Db; env: Env },
): Promise<void> {
  const { db, env } = deps;

  app.get('/admin/reports/delivery', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });

    const q = request.query as { days?: string };
    const days = Math.min(Math.max(Number(q.days ?? 30) || 30, 7), 180);

    const byCarrier = await db.query<{
      carrier: string;
      delivered: string;
      exceptions: string;
      in_flight: string;
      avg_transit_days: string | null;
      on_time: string;
      late: string;
    }>(
      `SELECT
         coalesce(c.display_name, s.carrier_code, '(unknown)') AS carrier,
         count(*) FILTER (WHERE s.internal_status = 'DELIVERED')::text AS delivered,
         count(*) FILTER (WHERE s.internal_status = 'EXCEPTION')::text AS exceptions,
         count(*) FILTER (
           WHERE s.internal_status NOT IN ('DELIVERED','CANCELLED','RETURNED_TO_SENDER')
         )::text AS in_flight,
         round(avg(
           CASE
             WHEN s.delivered_at IS NOT NULL AND s.shipped_at IS NOT NULL
             THEN extract(epoch FROM (s.delivered_at - s.shipped_at)) / 86400.0
             ELSE NULL
           END
         )::numeric, 1)::text AS avg_transit_days,
         count(*) FILTER (
           WHERE s.internal_status = 'DELIVERED'
             AND s.edd IS NOT NULL
             AND s.delivered_at IS NOT NULL
             AND s.delivered_at::date <= s.edd::date
         )::text AS on_time,
         count(*) FILTER (
           WHERE s.internal_status = 'DELIVERED'
             AND s.edd IS NOT NULL
             AND s.delivered_at IS NOT NULL
             AND s.delivered_at::date > s.edd::date
         )::text AS late
       FROM shipments s
       LEFT JOIN carriers c ON c.code = s.carrier_code
       WHERE s.created_at > now() - ($1::text || ' days')::interval
       GROUP BY 1
       ORDER BY count(*) FILTER (WHERE s.internal_status = 'DELIVERED') DESC`,
      [String(days)],
    );

    const bySource = await db.query<{
      source: string;
      delivered: string;
      exceptions: string;
      stalled: string;
      total: string;
      avg_transit_days: string | null;
    }>(
      `SELECT
         s.source,
         count(*)::text AS total,
         count(*) FILTER (WHERE s.internal_status = 'DELIVERED')::text AS delivered,
         count(*) FILTER (WHERE s.internal_status = 'EXCEPTION')::text AS exceptions,
         count(*) FILTER (WHERE s.is_stalled)::text AS stalled,
         round(avg(
           CASE
             WHEN s.delivered_at IS NOT NULL AND s.shipped_at IS NOT NULL
             THEN extract(epoch FROM (s.delivered_at - s.shipped_at)) / 86400.0
             ELSE NULL
           END
         )::numeric, 1)::text AS avg_transit_days
       FROM shipments s
       WHERE s.created_at > now() - ($1::text || ' days')::interval
       GROUP BY 1
       ORDER BY 1`,
      [String(days)],
    );

    const deliveredDaily = await db.query<{ day: string; n: string }>(
      `SELECT to_char(delivered_at::date, 'YYYY-MM-DD') AS day, count(*)::text AS n
       FROM shipments
       WHERE delivered_at IS NOT NULL
         AND delivered_at > now() - ($1::text || ' days')::interval
       GROUP BY 1
       ORDER BY 1`,
      [String(days)],
    );

    const summary = await db.query<{
      total: string;
      delivered: string;
      exception_rate: string | null;
      avg_transit_days: string | null;
      stalled: string;
    }>(
      `SELECT
         count(*)::text AS total,
         count(*) FILTER (WHERE internal_status = 'DELIVERED')::text AS delivered,
         round(
           100.0 * count(*) FILTER (WHERE internal_status = 'EXCEPTION')
           / nullif(count(*), 0),
           2
         )::text AS exception_rate,
         round(avg(
           CASE
             WHEN delivered_at IS NOT NULL AND shipped_at IS NOT NULL
             THEN extract(epoch FROM (delivered_at - shipped_at)) / 86400.0
           END
         )::numeric, 1)::text AS avg_transit_days,
         count(*) FILTER (WHERE is_stalled)::text AS stalled
       FROM shipments
       WHERE created_at > now() - ($1::text || ' days')::interval`,
      [String(days)],
    );

    return {
      days,
      summary: {
        total: Number(summary.rows[0]?.total ?? 0),
        delivered: Number(summary.rows[0]?.delivered ?? 0),
        exceptionRatePct: summary.rows[0]?.exception_rate
          ? Number(summary.rows[0].exception_rate)
          : 0,
        avgTransitDays: summary.rows[0]?.avg_transit_days
          ? Number(summary.rows[0].avg_transit_days)
          : null,
        stalled: Number(summary.rows[0]?.stalled ?? 0),
      },
      byCarrier: byCarrier.rows.map((r) => ({
        carrier: r.carrier,
        delivered: Number(r.delivered),
        exceptions: Number(r.exceptions),
        inFlight: Number(r.in_flight),
        avgTransitDays: r.avg_transit_days ? Number(r.avg_transit_days) : null,
        onTime: Number(r.on_time),
        late: Number(r.late),
      })),
      bySource: bySource.rows.map((r) => ({
        source: r.source,
        total: Number(r.total),
        delivered: Number(r.delivered),
        exceptions: Number(r.exceptions),
        stalled: Number(r.stalled),
        avgTransitDays: r.avg_transit_days ? Number(r.avg_transit_days) : null,
      })),
      deliveredDaily: deliveredDaily.rows.map((r) => ({
        day: r.day,
        n: Number(r.n),
      })),
    };
  });
}
