import type { FastifyInstance } from 'fastify';
import type { Env } from '../config.js';
import type { Db } from '../db/pool.js';
import { authorizeApiKey } from '../lib/api-key-auth.js';
import {
  lookupOpsShipments,
  validateOpsLookupItems,
  type OpsLookupItem,
  type OpsSource,
} from '../domain/ops-lookup.js';

type Deps = { db: Db; env: Env };

function unauthorized(reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  return reply.code(401).send({ error: 'unauthorized' });
}

export async function registerOpsRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { db, env } = deps;

  app.post('/api/ops/shipments/lookup', async (request, reply) => {
    if (!authorizeApiKey(request, env.OPS_API_KEY)) return unauthorized(reply);

    const body = (request.body ?? {}) as { orders?: unknown };
    const validated = validateOpsLookupItems(body.orders);
    if (!validated.ok) {
      return reply.code(400).send(validated.error);
    }

    const results = await lookupOpsShipments(db, validated.items);
    return { results };
  });

  app.get<{
    Params: { sourceOrderId: string };
    Querystring: { source?: string };
  }>('/api/ops/shipments/:sourceOrderId', async (request, reply) => {
    if (!authorizeApiKey(request, env.OPS_API_KEY)) return unauthorized(reply);

    const sourceOrderId = request.params.sourceOrderId?.trim();
    const sourceRaw = request.query.source?.trim();
    if (!sourceOrderId) {
      return reply.code(400).send({ error: 'invalid_source_order_id' });
    }
    if (sourceRaw !== 'shipbob' && sourceRaw !== 'klb') {
      return reply.code(400).send({ error: 'invalid_source', detail: 'source must be shipbob or klb' });
    }
    const source = sourceRaw as OpsSource;

    const item: OpsLookupItem = {
      clientRef: `${source}:${sourceOrderId}`,
      source,
      sourceOrderId,
    };
    const [result] = await lookupOpsShipments(db, [item]);
    if (!result || !result.found) {
      return reply.code(404).send({ error: 'not_found' });
    }
    // Same shape as one found element of the bulk results, minus clientRef wrapper noise —
    // keep clientRef out; return order + shipments fields.
    return {
      found: true,
      orderNumber: result.orderNumber,
      currentStatus: result.currentStatus,
      shipments: result.shipments,
    };
  });
}
