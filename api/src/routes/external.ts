import type { FastifyInstance } from 'fastify';
import type { Env } from '../config.js';
import type { Db } from '../db/pool.js';
import { lookupExternalOrder, normalizeExternalOrderId } from '../domain/external-order.js';
import { authorizeApiKey } from '../lib/api-key-auth.js';

type Deps = { db: Db; env: Env };

/**
 * Read-only order status for external consumers (Woo order id).
 * Auth: X-Api-Key / Bearer EXTERNAL_API_KEY.
 */
export async function registerExternalRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { db, env } = deps;

  app.get<{ Params: { orderId: string } }>('/api/v1/orders/:orderId', async (request, reply) => {
    if (!authorizeApiKey(request, env.EXTERNAL_API_KEY)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const orderId = normalizeExternalOrderId(request.params.orderId ?? '');
    if (!orderId) return reply.code(400).send({ error: 'invalid_order_id' });

    const payload = await lookupExternalOrder(db, orderId);
    if (!payload) return reply.code(404).send({ error: 'not_found' });
    return payload;
  });
}
