import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { Env } from '../config.js';
import type { Db } from '../db/pool.js';

const OPS_KEY = 'ops-test-secret';

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: 'postgres://unused',
    REDIS_URL: 'redis://localhost:6379',
    PORT: 3000,
    PUBLIC_BASE_URL: 'http://localhost:3000',
    ADMIN_SESSION_SECRET: 'test-session-secret',
    APP_VERSION: '0.1.0',
    GIT_SHA: 'test',
    SHIPBOB_CHANNEL_ID: '180705',
    SHIPBOB_API_BASE: 'https://api.shipbob.com/1.0',
    SHIPBOB_TRACKING_API_BASE: 'https://api.shipbob.com/2026-07',
    SHIPBOB_ORDERS_LOOKBACK_HOURS: 48,
    KLB_API_BASE: 'https://app.zenventory.com/rest',
    KLB_WINDOW_DAYS: 30,
    TRACKINGMORE_API_BASE: 'https://api.trackingmore.com/v4',
    STALLED_DAYS: 7,
    OPS_API_KEY: OPS_KEY,
    ...overrides,
  };
}

function mockDb(rows: unknown[] = []): Db {
  return {
    query: async () => ({ rows, rowCount: rows.length }),
  } as unknown as Db;
}

describe('ops routes', () => {
  let app: FastifyInstance;

  before(async () => {
    const shippedAt = new Date('2026-08-01T10:00:00Z');
    const rows = [
      {
        order_id: 'o1',
        order_number: '4057462',
        current_status: 'IN_TRANSIT',
        source: 'shipbob',
        source_shipment_id: 's1',
        source_order_id: '381894238',
        carrier_code: 'ups',
        carrier_service: null,
        tracking_number: '1Z',
        carrier_tracking_url: null,
        internal_status: 'IN_TRANSIT',
        is_stalled: false,
        shipped_at: shippedAt,
        delivered_at: null,
        last_event_at: shippedAt,
        edd: null,
      },
    ];
    app = await buildApp({ db: mockDb(rows), env: testEnv(), logger: false });
  });

  after(async () => {
    await app.close();
  });

  it('returns 401 without API key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ops/shipments/lookup',
      payload: { orders: [{ clientRef: 'a', orderNumber: '1' }] },
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 when OPS_API_KEY unset', async () => {
    const bare = await buildApp({
      db: mockDb(),
      env: testEnv({ OPS_API_KEY: undefined }),
      logger: false,
    });
    try {
      const res = await bare.inject({
        method: 'POST',
        url: '/api/ops/shipments/lookup',
        headers: { 'x-api-key': 'anything' },
        payload: { orders: [{ clientRef: 'a', orderNumber: '1' }] },
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await bare.close();
    }
  });

  it('rejects empty batch with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ops/shipments/lookup',
      headers: { 'x-api-key': OPS_KEY },
      payload: { orders: [] },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'empty_batch');
  });

  it('rejects zenventory source with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ops/shipments/lookup',
      headers: { authorization: `Bearer ${OPS_KEY}` },
      payload: {
        orders: [{ clientRef: 'a', source: 'zenventory', sourceOrderId: '1' }],
      },
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: 'invalid_source', clientRef: 'a' });
  });

  it('bulk lookup returns found + missing in request order', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ops/shipments/lookup',
      headers: { 'x-api-key': OPS_KEY },
      payload: {
        orders: [
          { clientRef: 'hit', source: 'shipbob', sourceOrderId: '381894238' },
          { clientRef: 'miss', source: 'klb', sourceOrderId: 'nope' },
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].found, true);
    assert.equal(body.results[0].clientRef, 'hit');
    assert.equal(body.results[0].shipments[0].internalStatus, 'IN_TRANSIT');
    assert.equal(body.results[0].shipments[0].isStalled, false);
    assert.equal(body.results[1].found, false);
  });

  it('GET single lookup by sourceOrderId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ops/shipments/381894238?source=shipbob',
      headers: { 'x-api-key': OPS_KEY },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.found, true);
    assert.equal(body.orderNumber, '4057462');
    assert.equal(body.shipments.length, 1);
  });

  it('GET returns 404 when not found', async () => {
    const emptyApp = await buildApp({ db: mockDb([]), env: testEnv(), logger: false });
    try {
      const res = await emptyApp.inject({
        method: 'GET',
        url: '/api/ops/shipments/missing?source=shipbob',
        headers: { 'x-api-key': OPS_KEY },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await emptyApp.close();
    }
  });

  it('GET rejects invalid source', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ops/shipments/1?source=zenventory',
      headers: { 'x-api-key': OPS_KEY },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_source');
  });
});
