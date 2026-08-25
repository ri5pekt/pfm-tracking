import type { Db } from '../db/pool.js';

export const OPS_LOOKUP_MAX_BATCH = 500;

export type OpsSource = 'shipbob' | 'klb';

export type OpsLookupItem = {
  clientRef: string;
  source?: OpsSource;
  sourceOrderId?: string;
  orderNumber?: string;
};

export type OpsShipmentResult = {
  source: OpsSource;
  sourceShipmentId: string;
  sourceOrderId: string | null;
  carrierCode: string | null;
  carrierService: string | null;
  trackingNumber: string | null;
  carrierTrackingUrl: string | null;
  internalStatus: string;
  isStalled: boolean;
  shippedAt: string | null;
  deliveredAt: string | null;
  lastEventAt: string | null;
  edd: string | null;
};

export type OpsFoundResult = {
  clientRef: string;
  found: true;
  orderNumber: string;
  currentStatus: string;
  shipments: OpsShipmentResult[];
};

export type OpsMissingResult = {
  clientRef: string;
  found: false;
};

export type OpsLookupResult = OpsFoundResult | OpsMissingResult;

export type OpsLookupValidationError =
  | { error: 'empty_batch' }
  | { error: 'batch_too_large'; max: number }
  | { error: 'invalid_source'; clientRef: string }
  | { error: 'no_matcher'; clientRef: string }
  | { error: 'invalid_item'; clientRef: string; detail: string };

type ShipmentRow = {
  order_id: string;
  order_number: string;
  current_status: string;
  source: OpsSource;
  source_shipment_id: string;
  source_order_id: string | null;
  carrier_code: string | null;
  carrier_service: string | null;
  tracking_number: string | null;
  carrier_tracking_url: string | null;
  internal_status: string;
  is_stalled: boolean;
  shipped_at: Date | null;
  delivered_at: Date | null;
  last_event_at: Date | null;
  edd: Date | null;
};

type OrderGroup = {
  orderNumber: string;
  currentStatus: string;
  shipments: OpsShipmentResult[];
};

function iso(d: Date | null): string | null {
  return d ? new Date(d).toISOString() : null;
}

function toShipment(row: ShipmentRow): OpsShipmentResult {
  return {
    source: row.source,
    sourceShipmentId: row.source_shipment_id,
    sourceOrderId: row.source_order_id,
    carrierCode: row.carrier_code,
    carrierService: row.carrier_service,
    trackingNumber: row.tracking_number,
    carrierTrackingUrl: row.carrier_tracking_url,
    internalStatus: row.internal_status,
    isStalled: row.is_stalled,
    shippedAt: iso(row.shipped_at),
    deliveredAt: iso(row.delivered_at),
    lastEventAt: iso(row.last_event_at),
    edd: iso(row.edd),
  };
}

export function validateOpsLookupItems(
  items: unknown,
): { ok: true; items: OpsLookupItem[] } | { ok: false; error: OpsLookupValidationError } {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: { error: 'empty_batch' } };
  }
  if (items.length > OPS_LOOKUP_MAX_BATCH) {
    return { ok: false, error: { error: 'batch_too_large', max: OPS_LOOKUP_MAX_BATCH } };
  }

  const out: OpsLookupItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: { error: 'invalid_item', clientRef: '', detail: 'item must be object' } };
    }
    const rec = raw as Record<string, unknown>;
    const clientRef = typeof rec.clientRef === 'string' ? rec.clientRef.trim() : '';
    if (!clientRef) {
      return {
        ok: false,
        error: { error: 'invalid_item', clientRef: '', detail: 'clientRef required' },
      };
    }

    let source: OpsSource | undefined;
    if (rec.source !== undefined && rec.source !== null && rec.source !== '') {
      if (rec.source !== 'shipbob' && rec.source !== 'klb') {
        return { ok: false, error: { error: 'invalid_source', clientRef } };
      }
      source = rec.source;
    }

    const sourceOrderId =
      typeof rec.sourceOrderId === 'string' && rec.sourceOrderId.trim()
        ? rec.sourceOrderId.trim()
        : undefined;
    const orderNumber =
      typeof rec.orderNumber === 'string' && rec.orderNumber.trim()
        ? rec.orderNumber.trim()
        : undefined;

    if (!sourceOrderId && !orderNumber) {
      return { ok: false, error: { error: 'no_matcher', clientRef } };
    }
    // source without sourceOrderId is useless for primary match but allowed if orderNumber present
    if (source && !sourceOrderId && !orderNumber) {
      return { ok: false, error: { error: 'no_matcher', clientRef } };
    }

    out.push({ clientRef, source, sourceOrderId, orderNumber });
  }
  return { ok: true, items: out };
}

function groupRows(rows: ShipmentRow[]): {
  bySourceKey: Map<string, OrderGroup>;
  byOrderNumber: Map<string, OrderGroup>;
} {
  const byOrderId = new Map<string, OrderGroup>();
  for (const row of rows) {
    let group = byOrderId.get(row.order_id);
    if (!group) {
      group = {
        orderNumber: row.order_number,
        currentStatus: row.current_status,
        shipments: [],
      };
      byOrderId.set(row.order_id, group);
    }
    group.shipments.push(toShipment(row));
  }

  const bySourceKey = new Map<string, OrderGroup>();
  const byOrderNumber = new Map<string, OrderGroup>();
  for (const group of byOrderId.values()) {
    byOrderNumber.set(group.orderNumber, group);
    for (const s of group.shipments) {
      if (s.sourceOrderId) {
        bySourceKey.set(`${s.source}|${s.sourceOrderId}`, group);
      }
    }
  }
  return { bySourceKey, byOrderNumber };
}

export async function lookupOpsShipments(
  db: Db,
  items: OpsLookupItem[],
): Promise<OpsLookupResult[]> {
  const sourceList: string[] = [];
  const sourceOrderIdList: string[] = [];
  const orderNumbers = new Set<string>();

  for (const item of items) {
    if (item.source && item.sourceOrderId) {
      sourceList.push(item.source);
      sourceOrderIdList.push(item.sourceOrderId);
    }
    if (item.orderNumber) orderNumbers.add(item.orderNumber);
  }

  const orderNumberList = [...orderNumbers];

  const { rows } = await db.query<ShipmentRow>(
    `SELECT
       o.id AS order_id,
       o.order_number,
       o.current_status,
       s.source,
       s.source_shipment_id,
       s.source_order_id,
       s.carrier_code,
       s.carrier_service,
       s.tracking_number,
       s.carrier_tracking_url,
       s.internal_status,
       s.is_stalled,
       s.shipped_at,
       s.delivered_at,
       s.last_event_at,
       s.edd
     FROM shipments s
     JOIN orders o ON o.id = s.order_id
     WHERE
       (
         cardinality($1::text[]) > 0
         AND (s.source, s.source_order_id) IN (
           SELECT t.source, t.source_order_id
           FROM unnest($1::text[], $2::text[]) AS t(source, source_order_id)
         )
       )
       OR (
         cardinality($3::text[]) > 0
         AND o.order_number = ANY($3::text[])
       )
     ORDER BY o.id, s.created_at`,
    [sourceList, sourceOrderIdList, orderNumberList],
  );

  const { bySourceKey, byOrderNumber } = groupRows(rows);

  return items.map((item) => {
    let group: OrderGroup | undefined;
    if (item.source && item.sourceOrderId) {
      group = bySourceKey.get(`${item.source}|${item.sourceOrderId}`);
    }
    if (!group && item.orderNumber) {
      group = byOrderNumber.get(item.orderNumber);
    }
    if (!group) {
      return { clientRef: item.clientRef, found: false };
    }
    return {
      clientRef: item.clientRef,
      found: true,
      orderNumber: group.orderNumber,
      currentStatus: group.currentStatus,
      shipments: group.shipments,
    };
  });
}
