import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { Env } from '../config.js';
import type { Db } from '../db/pool.js';

const EXT_KEY = 'external-test-secret';

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
    EXTERNAL_API_KEY: EXT_KEY,
    ...overrides,
  };
}

function mockDb(responses: unknown[][]): Db {
  let i = 0;
  return {
    query: async () => {
      const rows = responses[i++] ?? [];
      return { rows, rowCount: rows.length };
    },
  } as unknown as Db;
}

const orderRow = {
  id: 'o1',
  order_number: '4081591',
  current_status: 'IN_TRANSIT',
};

const shipmentRow = {
  id: 's1',
  tracking_number: '9400111',
  carrier_code: 'dhl_ecs',
  carrier_name: 'DHL eCommerce',
  carrier_tracking_url: null,
  tracking_url_template: 'https://www.dhl.com/global-en/home/tracking.html?tracking-id={tracking_number}',
  internal_status: 'IN_TRANSIT',
  is_stalled: false,
  edd: new Date('2026-08-26T00:00:00Z'),
  last_event_at: new Date('2026-08-24T12:00:00Z'),
};

describe('external order API', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({
      db: mockDb([[orderRow], [shipmentRow]]),
      env: testEnv(),
      logger: false,
    });
  });

  after(async () => {
    await app.close();
  });

  it('returns 401 without API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/4081591' });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 when EXTERNAL_API_KEY is unset', async () => {
    const bare = await buildApp({
      db: mockDb([[orderRow], [shipmentRow]]),
      env: testEnv({ EXTERNAL_API_KEY: undefined }),
      logger: false,
    });
    try {
      const res = await bare.inject({
        method: 'GET',
        url: '/api/v1/orders/4081591',
        headers: { 'x-api-key': 'anything' },
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await bare.close();
    }
  });

  it('returns status and carrier for a Woo order id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/4081591',
      headers: { 'x-api-key': EXT_KEY },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.orderId, '4081591');
    assert.equal(body.status, 'IN_TRANSIT');
    assert.equal(body.statusLabel, 'In transit');
    assert.equal(body.carrier, 'DHL eCommerce');
    assert.equal(body.shipments.length, 1);
    assert.equal(body.shipments[0].carrier, 'DHL eCommerce');
    assert.equal(body.shipments[0].carrierCode, 'dhl_ecs');
    assert.equal(
      body.shipments[0].trackingUrl,
      'https://www.dhl.com/global-en/home/tracking.html?tracking-id=9400111',
    );
    assert.equal(body.shipments[0].edd, '2026-08-26T00:00:00.000Z');
  });

  it('accepts Bearer auth and a leading # on the order id', async () => {
    const hashed = await buildApp({
      db: mockDb([[orderRow], [shipmentRow]]),
      env: testEnv(),
      logger: false,
    });
    try {
      const res = await hashed.inject({
        method: 'GET',
        url: '/api/v1/orders/%234081591',
        headers: { authorization: `Bearer ${EXT_KEY}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().orderId, '4081591');
    } finally {
      await hashed.close();
    }
  });

  it('returns 404 when the order is not in the hub', async () => {
    const empty = await buildApp({
      db: mockDb([[]]),
      env: testEnv(),
      logger: false,
    });
    try {
      const res = await empty.inject({
        method: 'GET',
        url: '/api/v1/orders/9999999',
        headers: { 'x-api-key': EXT_KEY },
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error, 'not_found');
    } finally {
      await empty.close();
    }
  });
});
