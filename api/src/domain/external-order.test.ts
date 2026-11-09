import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Db } from '../db/pool.js';
import {
  normalizeExternalOrderId,
  primaryCarrier,
  resolveCarrierTrackingUrl,
  resolveExternalOrder,
} from './external-order.js';

function mockDb(responses: unknown[][]): Db {
  let i = 0;
  return {
    query: async () => {
      const rows = responses[i++] ?? [];
      return { rows, rowCount: rows.length };
    },
  } as unknown as Db;
}

describe('external order helpers', () => {
  it('strips whitespace and a leading # from Woo order ids', () => {
    assert.equal(normalizeExternalOrderId('  #4081591  '), '4081591');
    assert.equal(normalizeExternalOrderId('4081591'), '4081591');
  });

  it('prefers stored carrier URL, else fills the template', () => {
    assert.equal(
      resolveCarrierTrackingUrl('https://dhl.example/abc', 'https://t/{tracking_number}', '1Z'),
      'https://dhl.example/abc',
    );
    assert.equal(
      resolveCarrierTrackingUrl(null, 'https://t/{tracking_number}', '1Z 99'),
      'https://t/1Z%2099',
    );
    assert.equal(resolveCarrierTrackingUrl(null, null, '1Z'), null);
  });

  it('picks the carrier of the shipment matching roll-up status', () => {
    assert.equal(
      primaryCarrier(
        [
          { status: 'DELIVERED', carrier: 'USPS' },
          { status: 'IN_TRANSIT', carrier: 'DHL eCommerce' },
        ],
        'IN_TRANSIT',
      ),
      'DHL eCommerce',
    );
    assert.equal(primaryCarrier([{ status: 'IN_TRANSIT', carrier: 'UPS' }], 'IN_TRANSIT'), 'UPS');
    assert.equal(primaryCarrier([], 'IN_TRANSIT'), null);
  });
});

describe('resolveExternalOrder', () => {
  it('does not hydrate when the order is already in the hub', async () => {
    let hydrated = 0;
    const db = mockDb([
      [{ id: 'o1', order_number: '4090421', current_status: 'LABEL_CREATED' }],
      [],
    ]);
    const payload = await resolveExternalOrder(db, '4090421', async () => {
      hydrated += 1;
      return true;
    });
    assert.equal(hydrated, 0);
    assert.equal(payload?.orderId, '4090421');
  });

  it('hydrates from vendors on a miss, then returns the ingested order', async () => {
    let hydrated = 0;
    const db = mockDb([
      [],
      [{ id: 'o1', order_number: '4090421', current_status: 'LABEL_CREATED' }],
      [
        {
          id: 's1',
          tracking_number: '1Z',
          carrier_code: 'dhl_ecs',
          carrier_name: 'DHL eCommerce',
          carrier_tracking_url: null,
          tracking_url_template: null,
          internal_status: 'LABEL_CREATED',
          is_stalled: false,
          edd: null,
          last_event_at: null,
        },
      ],
    ]);
    const payload = await resolveExternalOrder(db, '4090421', async () => {
      hydrated += 1;
      return true;
    });
    assert.equal(hydrated, 1);
    assert.equal(payload?.orderId, '4090421');
    assert.equal(payload?.carrier, 'DHL eCommerce');
  });

  it('returns null when vendors also do not have the order', async () => {
    const db = mockDb([[]]);
    const payload = await resolveExternalOrder(db, '9999999', async () => false);
    assert.equal(payload, null);
  });
});
