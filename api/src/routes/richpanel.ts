import type { FastifyInstance } from 'fastify';
import type { Env } from '../config.js';
import type { Db } from '../db/pool.js';
import { resolveOrderTrackingUrl, statusLabel } from '../domain/public-tracking.js';

type Deps = { db: Db; env: Env };

function authorizeRichPanel(request: { headers: Record<string, unknown> }, env: Env): boolean {
  if (!env.RICHPANEL_API_KEY) return false;
  const header = request.headers['x-api-key'] ?? request.headers.authorization;
  if (typeof header !== 'string') return false;
  const token = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : header.trim();
  return token === env.RICHPANEL_API_KEY;
}

export async function registerRichPanelRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { db, env } = deps;

  app.get<{ Params: { orderNumber: string } }>(
    '/api/richpanel/orders/:orderNumber',
    async (request, reply) => {
      if (!authorizeRichPanel(request, env)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const orderNumber = request.params.orderNumber?.trim();
      if (!orderNumber) return reply.code(400).send({ error: 'invalid_order_number' });

      const { rows } = await db.query<{
        id: string;
        order_number: string;
        customer_email: string | null;
        current_status: string;
        destination_country: string | null;
      }>(
        `SELECT id, order_number, customer_email, current_status, destination_country
         FROM orders WHERE order_number = $1`,
        [orderNumber],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
      const order = rows[0];

      const trackingUrl = await resolveOrderTrackingUrl(
        db,
        order.id,
        env.ADMIN_SESSION_SECRET,
        env.PUBLIC_BASE_URL,
      );

      const shipments = await db.query<{
        id: string;
        tracking_number: string | null;
        carrier_code: string | null;
        carrier_name: string | null;
        carrier_tracking_url: string | null;
        internal_status: string;
        is_stalled: boolean;
        edd: Date | null;
        last_event_at: Date | null;
      }>(
        `SELECT s.id, s.tracking_number, s.carrier_code, c.display_name AS carrier_name,
                s.carrier_tracking_url, s.internal_status, s.is_stalled, s.edd, s.last_event_at
         FROM shipments s
         LEFT JOIN carriers c ON c.code = s.carrier_code
         WHERE s.order_id = $1
         ORDER BY s.created_at`,
        [order.id],
      );

      return {
        orderNumber: order.order_number,
        email: order.customer_email,
        status: order.current_status,
        statusLabel: statusLabel(order.current_status),
        destinationCountry: order.destination_country,
        trackingPageUrl: trackingUrl,
        shipments: shipments.rows.map((s) => ({
          id: s.id,
          trackingNumber: s.tracking_number,
          carrier: s.carrier_name ?? s.carrier_code,
          carrierTrackingUrl: s.carrier_tracking_url,
          status: s.internal_status,
          statusLabel: statusLabel(s.internal_status),
          isStalled: s.is_stalled,
          edd: s.edd ? new Date(s.edd).toISOString() : null,
          lastEventAt: s.last_event_at ? new Date(s.last_event_at).toISOString() : null,
        })),
      };
    },
  );
}
