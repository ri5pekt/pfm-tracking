import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/pool.js';
import type { Env } from '../config.js';
import { loadNotificationEnv, replayNotification } from '../domain/notifications.js';
import { resolveOrderTrackingUrl } from '../domain/public-tracking.js';
import { writeAudit } from '../lib/audit.js';
import { getSession } from '../lib/session.js';
import { TrackingMoreClient } from '../integrations/trackingmore/client.js';
import { retrackShipment } from '../integrations/trackingmore/retrack.js';

export async function registerAdminShipmentRoutes(
  app: FastifyInstance,
  deps: { db: Db; env: Env },
): Promise<void> {
  const { db, env } = deps;

  app.get('/admin/shipments', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });

    const query = request.query as {
      q?: string;
      status?: string;
      source?: string;
      page?: string;
      pageSize?: string;
      limit?: string;
      offset?: string;
      sortBy?: string;
      sortDir?: string;
    };

    const allowedPageSizes = new Set([20, 50, 100]);
    const pageSizeRaw = Number(query.pageSize ?? query.limit ?? 20) || 20;
    const pageSize = allowedPageSizes.has(pageSizeRaw) ? pageSizeRaw : 20;
    const page = Math.max(Number(query.page ?? 1) || 1, 1);
    const offset =
      query.offset != null && query.offset !== ''
        ? Math.max(Number(query.offset) || 0, 0)
        : (page - 1) * pageSize;

    const sortDir = query.sortDir?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const sortMap: Record<string, string> = {
      tracking_number: 's.tracking_number',
      carrier_name: 'c.display_name',
      order_number: 'o.order_number',
      internal_status: 's.status_rank',
      order_created_at: 'o.ordered_at',
      order_imported_at: 'o.created_at',
      latest_event_at: 'le.occurred_at',
      source: 's.source',
      last_event_at: 's.last_event_at',
    };
    const sortByKey = query.sortBy && sortMap[query.sortBy] ? query.sortBy : 'order_imported_at';
    const sortExpr = sortMap[sortByKey];

    const q = query.q?.trim() || null;
    const statusTab = query.status?.trim() || 'all';
    const sourceRaw = (query.source?.trim() || 'all').toLowerCase();
    const sourceFilter =
      sourceRaw === 'shipbob' || sourceRaw === 'klb' ? sourceRaw : 'all';

    const countParams: unknown[] = [];
    const countWhere =
      sourceFilter === 'all'
        ? ''
        : (() => {
            countParams.push(sourceFilter);
            return `WHERE source = $1`;
          })();

    const countsResult = await db.query<{
      all: string;
      order_received: string;
      processing: string;
      label_created: string;
      in_transit: string;
      out_for_delivery: string;
      exception: string;
      stalled: string;
      delivered: string;
      returned_to_sender: string;
      cancelled: string;
    }>(
      `SELECT
         count(*)::text AS all,
         count(*) FILTER (WHERE internal_status = 'ORDER_RECEIVED')::text AS order_received,
         count(*) FILTER (WHERE internal_status = 'PROCESSING')::text AS processing,
         count(*) FILTER (WHERE internal_status = 'LABEL_CREATED')::text AS label_created,
         count(*) FILTER (WHERE internal_status = 'IN_TRANSIT')::text AS in_transit,
         count(*) FILTER (WHERE internal_status = 'OUT_FOR_DELIVERY')::text AS out_for_delivery,
         count(*) FILTER (WHERE internal_status = 'EXCEPTION')::text AS exception,
         count(*) FILTER (WHERE is_stalled)::text AS stalled,
         count(*) FILTER (WHERE internal_status = 'DELIVERED')::text AS delivered,
         count(*) FILTER (WHERE internal_status = 'RETURNED_TO_SENDER')::text AS returned_to_sender,
         count(*) FILTER (WHERE internal_status = 'CANCELLED')::text AS cancelled
       FROM shipments
       ${countWhere}`,
      countParams,
    );

    const filters: string[] = [];
    const params: unknown[] = [];

    if (sourceFilter !== 'all') {
      params.push(sourceFilter);
      filters.push(`s.source = $${params.length}`);
    }

    const statusFilters: Record<string, string> = {
      order_received: `s.internal_status = 'ORDER_RECEIVED'`,
      processing: `s.internal_status = 'PROCESSING'`,
      label_created: `s.internal_status = 'LABEL_CREATED'`,
      in_transit: `s.internal_status = 'IN_TRANSIT'`,
      out_for_delivery: `s.internal_status = 'OUT_FOR_DELIVERY'`,
      exception: `s.internal_status = 'EXCEPTION'`,
      stalled: `s.is_stalled = true`,
      delivered: `s.internal_status = 'DELIVERED'`,
      returned_to_sender: `s.internal_status = 'RETURNED_TO_SENDER'`,
      cancelled: `s.internal_status = 'CANCELLED'`,
    };
    if (statusTab !== 'all' && statusFilters[statusTab]) {
      filters.push(statusFilters[statusTab]!);
    }

    if (q) {
      params.push(`%${q}%`);
      filters.push(
        `(o.order_number ILIKE $${params.length}
          OR o.customer_email ILIKE $${params.length}
          OR s.tracking_number ILIKE $${params.length})`,
      );
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const totalResult = await db.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM shipments s
       JOIN orders o ON o.id = s.order_id
       ${where}`,
      params,
    );
    const total = Number(totalResult.rows[0]?.total ?? 0);

    params.push(pageSize);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const { rows } = await db.query(
      `SELECT
         s.id,
         s.source,
         s.tracking_number,
         s.carrier_code,
         s.carrier_service,
         s.internal_status,
         s.status_rank,
         s.is_stalled,
         s.shipped_at,
         s.delivered_at,
         s.last_event_at,
         s.created_at AS shipment_imported_at,
         o.order_number,
         o.customer_email,
         o.destination_city,
         o.destination_country,
         o.ordered_at AS order_created_at,
         o.created_at AS order_imported_at,
         c.display_name AS carrier_name,
         le.description AS latest_event_description,
         le.location AS latest_event_location,
         le.occurred_at AS latest_event_at
       FROM shipments s
       JOIN orders o ON o.id = s.order_id
       LEFT JOIN carriers c ON c.code = s.carrier_code
       LEFT JOIN LATERAL (
         SELECT description, location, occurred_at
         FROM tracking_events te
         WHERE te.shipment_id = s.id
         ORDER BY te.occurred_at DESC, te.status_rank DESC, te.id DESC
         LIMIT 1
       ) le ON true
       ${where}
       ORDER BY ${sortExpr} ${sortDir} NULLS LAST, s.id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return {
      items: rows,
      total,
      page,
      pageSize,
      sortBy: sortByKey,
      sortDir: sortDir.toLowerCase(),
      counts: {
        all: Number(countsResult.rows[0]?.all ?? 0),
        order_received: Number(countsResult.rows[0]?.order_received ?? 0),
        processing: Number(countsResult.rows[0]?.processing ?? 0),
        label_created: Number(countsResult.rows[0]?.label_created ?? 0),
        in_transit: Number(countsResult.rows[0]?.in_transit ?? 0),
        out_for_delivery: Number(countsResult.rows[0]?.out_for_delivery ?? 0),
        exception: Number(countsResult.rows[0]?.exception ?? 0),
        stalled: Number(countsResult.rows[0]?.stalled ?? 0),
        delivered: Number(countsResult.rows[0]?.delivered ?? 0),
        returned_to_sender: Number(countsResult.rows[0]?.returned_to_sender ?? 0),
        cancelled: Number(countsResult.rows[0]?.cancelled ?? 0),
      },
    };
  });

  app.get<{ Params: { id: string } }>('/admin/shipments/:id', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });

    const { rows } = await db.query(
      `SELECT
         s.*,
         o.order_number,
         o.customer_email,
         o.customer_name,
         o.customer_phone,
         o.ordered_at,
         o.destination_city,
         o.destination_country,
         o.destination_postcode,
         o.created_at AS order_imported_at,
         c.display_name AS carrier_name,
         c.code AS carrier_code_resolved,
         c.trackingmore_code
       FROM shipments s
       JOIN orders o ON o.id = s.order_id
       LEFT JOIN carriers c ON c.code = s.carrier_code
       WHERE s.id = $1`,
      [request.params.id],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });

    const events = await db.query(
      `SELECT id, occurred_at, received_at, internal_status, status_rank, source,
              raw_status, raw_substatus_code, raw_substatus, description,
              location, latitude, longitude, raw_payload
       FROM tracking_events
       WHERE shipment_id = $1
       ORDER BY occurred_at DESC, status_rank DESC, id DESC`,
      [request.params.id],
    );

    const items = await db.query(
      `SELECT si.id, si.sku, si.quantity,
              COALESCE(NULLIF(trim(si.title), ''), p.title) AS title,
              COALESCE(NULLIF(trim(si.image_url), ''), p.image_url) AS image_url
       FROM shipment_items si
       LEFT JOIN LATERAL (
         SELECT pr.title, pr.image_url
         FROM products pr
         LEFT JOIN product_sku_aliases a ON a.product_sku = pr.sku
         WHERE pr.sku = si.sku
            OR a.alias_sku = si.sku
            OR regexp_replace(pr.sku, '^0+', '') = regexp_replace(si.sku, '^0+', '')
         ORDER BY
           CASE
             WHEN pr.sku = si.sku THEN 0
             WHEN a.alias_sku = si.sku THEN 1
             ELSE 2
           END
         LIMIT 1
       ) p ON true
       WHERE si.shipment_id = $1
       ORDER BY si.created_at`,
      [request.params.id],
    );

    const shipment = rows[0] as Record<string, unknown>;
    const eventRows = events.rows as Array<{
      occurred_at: Date;
      location: string | null;
      internal_status: string;
    }>;

    const locations: string[] = [];
    for (const ev of eventRows) {
      const loc = ev.location?.trim();
      if (loc && !locations.includes(loc)) locations.push(loc);
      if (locations.length >= 3) break;
    }

    const oldest = eventRows.length ? eventRows[eventRows.length - 1] : null;
    const newest = eventRows[0] ?? null;
    const start =
      (shipment.shipped_at as Date | null) ??
      (oldest?.occurred_at ?? null) ??
      (shipment.ordered_at as Date | null);
    const end =
      (shipment.delivered_at as Date | null) ??
      (shipment.internal_status === 'DELIVERED' ? newest?.occurred_at : null) ??
      new Date();
    let transitDays: number | null = null;
    if (start) {
      transitDays = Math.max(
        0,
        Math.round((new Date(end).getTime() - new Date(start).getTime()) / (24 * 60 * 60 * 1000)),
      );
    }

    return {
      shipment: {
        ...shipment,
        latest_location: newest?.location ?? null,
        location_chips: locations,
        transit_days: transitDays,
        pickup_date: shipment.shipped_at ?? null,
      },
      events: events.rows,
      items: items.rows,
      notifications: (
        await db.query(
          `SELECT id, event_type, dedupe_key, status, payload, created_at, updated_at
           FROM notification_log
           WHERE shipment_id = $1
           ORDER BY created_at DESC`,
          [request.params.id],
        )
      ).rows,
    };
  });

  app.get<{ Params: { id: string } }>(
    '/admin/shipments/:id/tracking-link',
    async (request, reply) => {
      const user = getSession(request, env.ADMIN_SESSION_SECRET);
      if (!user) return reply.code(401).send({ error: 'unauthorized' });

      const { rows } = await db.query<{ order_id: string }>(
        `SELECT order_id FROM shipments WHERE id = $1`,
        [request.params.id],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'not_found' });

      const url = await resolveOrderTrackingUrl(
        db,
        rows[0].order_id,
        env.ADMIN_SESSION_SECRET,
        env.PUBLIC_BASE_URL,
      );
      if (!url) return reply.code(404).send({ error: 'token_unavailable' });
      return { url };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/shipments/:id/retrack',
    async (request, reply) => {
      const user = getSession(request, env.ADMIN_SESSION_SECRET);
      if (!user) return reply.code(401).send({ error: 'unauthorized' });

      if (!env.TRACKINGMORE_API_KEY) {
        return reply.code(503).send({ error: 'trackingmore_not_configured' });
      }

      const tm = new TrackingMoreClient({
        apiKey: env.TRACKINGMORE_API_KEY,
        apiBase: env.TRACKINGMORE_API_BASE,
        db,
      });

      const result = await retrackShipment(db, tm, request.params.id);
      await writeAudit(db, {
        actorId: user.id,
        action: 'shipment.retrack',
        targetType: 'shipment',
        targetId: request.params.id,
        metadata: result,
      });

      if (!result.ok) {
        const code =
          result.error === 'not_found'
            ? 404
            : result.error === 'not_trackingmore' || result.error === 'no_tracking_number'
              ? 400
              : 502;
        return reply.code(code).send({ error: result.error ?? 'retrack_failed', ...result });
      }

      return result;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/notifications/:id/replay',
    async (request, reply) => {
      const user = getSession(request, env.ADMIN_SESSION_SECRET);
      if (!user) return reply.code(401).send({ error: 'unauthorized' });

      const result = await replayNotification(
        db,
        request.params.id,
        user.id,
        loadNotificationEnv(),
      );

      await writeAudit(db, {
        actorId: user.id,
        action: 'notification.replay',
        targetType: 'notification_log',
        targetId: request.params.id,
        metadata: result,
      });

      if (!result.ok && result.error === 'not_found') {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (!result.ok) {
        return reply.code(502).send({ error: result.error ?? 'replay_failed', ...result });
      }
      return result;
    },
  );
}