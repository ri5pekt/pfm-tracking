import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OPS_LOOKUP_MAX_BATCH,
  validateOpsLookupItems,
  lookupOpsShipments,
  type OpsLookupItem,
} from './ops-lookup.js';
import type { Db } from '../db/pool.js';

describe('validateOpsLookupItems', () => {
  it('rejects empty batch', () => {
    assert.deepEqual(validateOpsLookupItems([]), { ok: false, error: { error: 'empty_batch' } });
    assert.deepEqual(validateOpsLookupItems(undefined), {
      ok: false,
      error: { error: 'empty_batch' },
    });
  });

  it('rejects batch over cap', () => {
    const items = Array.from({ length: OPS_LOOKUP_MAX_BATCH + 1 }, (_, i) => ({
      clientRef: `r${i}`,
      orderNumber: String(i),
    }));
    assert.deepEqual(validateOpsLookupItems(items), {
      ok: false,
      error: { error: 'batch_too_large', max: OPS_LOOKUP_MAX_BATCH },
    });
  });

  it('rejects zenventory / invalid source loudly', () => {
    const r = validateOpsLookupItems([
      { clientRef: 'a', source: 'zenventory', sourceOrderId: '1' },
    ]);
    assert.deepEqual(r, { ok: false, error: { error: 'invalid_source', clientRef: 'a' } });
  });

  it('rejects item with no matcher', () => {
    const r = validateOpsLookupItems([{ clientRef: 'a', source: 'shipbob' }]);
    assert.deepEqual(r, { ok: false, error: { error: 'no_matcher', clientRef: 'a' } });
  });

  it('rejects missing clientRef', () => {
    const r = validateOpsLookupItems([{ orderNumber: '1' }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.error, 'invalid_item');
  });

  it('accepts source+sourceOrderId and orderNumber fallback', () => {
    const r = validateOpsLookupItems([
      { clientRef: 'a', source: 'shipbob', sourceOrderId: '381' },
      { clientRef: 'b', orderNumber: '4057462' },
      { clientRef: 'c', source: 'klb', sourceOrderId: '9', orderNumber: 'x' },
    ]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.items.length, 3);
      assert.deepEqual(r.items[0], {
        clientRef: 'a',
        source: 'shipbob',
        sourceOrderId: '381',
        orderNumber: undefined,
      });
    }
  });
});

describe('lookupOpsShipments', () => {
  it('matches primary source key then falls back to orderNumber', async () => {
    const shippedAt = new Date('2026-08-01T10:00:00Z');
    const rows = [
      {
        order_id: 'o1',
        order_number: '4057462',
        current_status: 'IN_TRANSIT',
        source: 'shipbob' as const,
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

    const db = {
      query: async () => ({ rows, rowCount: rows.length }),
    } as unknown as Db;

    const items: OpsLookupItem[] = [
      { clientRef: 'hit-source', source: 'shipbob', sourceOrderId: '381894238' },
      { clientRef: 'hit-order', orderNumber: '4057462' },
      { clientRef: 'miss', source: 'klb', sourceOrderId: '999' },
      {
        clientRef: 'fallback',
        source: 'shipbob',
        sourceOrderId: 'nope',
        orderNumber: '4057462',
      },
    ];

    const results = await lookupOpsShipments(db, items);
    assert.equal(results[0]?.found, true);
    assert.equal(results[1]?.found, true);
    assert.equal(results[2]?.found, false);
    assert.equal(results[3]?.found, true);
    if (results[0]?.found) {
      assert.equal(results[0].orderNumber, '4057462');
      assert.equal(results[0].shipments[0]?.sourceShipmentId, 's1');
      assert.equal(results[0].shipments[0]?.shippedAt, shippedAt.toISOString());
      assert.equal(results[0].shipments[0]?.isStalled, false);
    }
  });

  it('returns all shipments for split orders', async () => {
    const rows = [
      {
        order_id: 'o1',
        order_number: '100',
        current_status: 'IN_TRANSIT',
        source: 'shipbob' as const,
        source_shipment_id: 'a',
        source_order_id: 'wo-1',
        carrier_code: null,
        carrier_service: null,
        tracking_number: 't1',
        carrier_tracking_url: null,
        internal_status: 'IN_TRANSIT',
        is_stalled: false,
        shipped_at: null,
        delivered_at: null,
        last_event_at: null,
        edd: null,
      },
      {
        order_id: 'o1',
        order_number: '100',
        current_status: 'IN_TRANSIT',
        source: 'shipbob' as const,
        source_shipment_id: 'b',
        source_order_id: 'wo-1',
        carrier_code: null,
        carrier_service: null,
        tracking_number: 't2',
        carrier_tracking_url: null,
        internal_status: 'LABEL_CREATED',
        is_stalled: false,
        shipped_at: null,
        delivered_at: null,
        last_event_at: null,
        edd: null,
      },
    ];
    const db = {
      query: async () => ({ rows, rowCount: rows.length }),
    } as unknown as Db;

    const [result] = await lookupOpsShipments(db, [
      { clientRef: 'split', source: 'shipbob', sourceOrderId: 'wo-1' },
    ]);
    assert.equal(result?.found, true);
    if (result?.found) assert.equal(result.shipments.length, 2);
  });
});
