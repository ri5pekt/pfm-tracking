import type { Db } from '../../db/pool.js';
import { loggedFetch, makeOnLog } from '../log.js';

export type ShipBobClientOptions = {
  apiKey: string;
  channelId: string;
  ordersBase: string;
  trackingBase: string;
  db?: Db | null;
};

export type ShipBobOrder = {
  id: number;
  order_number?: string;
  reference_id?: string;
  status?: string;
  created_date?: string;
  purchase_date?: string;
  recipient?: {
    name?: string;
    email?: string;
    phone_number?: string;
    address?: {
      city?: string;
      state?: string;
      country?: string;
      address1?: string;
      zip_code?: string;
    };
  };
  products?: Array<{ sku?: string; quantity?: number; name?: string; unit_price?: number }>;
  shipments?: Array<{
    id: number;
    status?: string;
    created_date?: string;
    tracking?: {
      tracking_number?: string;
      tracking_url?: string;
      carrier?: string;
    };
  }>;
};

export type ShipBobTrackingHistoryItem = {
  timestamp?: string;
  status?: string;
  substatus?: string;
  substatus_code?: string;
  substatus_message?: string;
  address?: {
    location?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
  };
};

export type ShipBobTrackingRecord = {
  shipment_id?: number;
  tracking_number?: string;
  carrier?: string;
  service?: string;
  current_status?: string;
  current_substatus?: string;
  current_substatus_code?: string;
  current_timestamp?: string;
  edd?: string;
  edd_source?: string;
  tracking_url?: string;
  last_mile_carrier?: unknown;
  delivery_signed_by?: string;
  proof_of_delivery_urls?: string[];
  history?: ShipBobTrackingHistoryItem[];
};

export class ShipBobClient {
  constructor(private readonly opts: ShipBobClientOptions) {}

  async listOrders(params: {
    page?: number;
    limit?: number;
    /** Filter by insert time (orders created after). Prefer lastUpdate* for sync. */
    startDate?: string;
    endDate?: string;
    /** Filter by last update — catches Processing → LabeledCreated after first ingest. */
    lastUpdateStartDate?: string;
    lastUpdateEndDate?: string;
    /** Filter by last tracking update (orders that already have tracking). */
    lastTrackingUpdateStartDate?: string;
    lastTrackingUpdateEndDate?: string;
    hasTracking?: boolean;
    /** ShipBob order ids, comma-separated on the wire. */
    ids?: Array<string | number>;
    /** Reference ids / store order numbers, comma-separated on the wire. */
    referenceIds?: string[];
  }): Promise<ShipBobOrder[]> {
    const url = new URL(`${this.opts.ordersBase.replace(/\/$/, '')}/order`);
    url.searchParams.set('Page', String(params.page ?? 1));
    url.searchParams.set('Limit', String(params.limit ?? 250));
    if (params.startDate) url.searchParams.set('StartDate', params.startDate);
    if (params.endDate) url.searchParams.set('EndDate', params.endDate);
    if (params.lastUpdateStartDate) {
      url.searchParams.set('LastUpdateStartDate', params.lastUpdateStartDate);
    }
    if (params.lastUpdateEndDate) {
      url.searchParams.set('LastUpdateEndDate', params.lastUpdateEndDate);
    }
    if (params.lastTrackingUpdateStartDate) {
      url.searchParams.set('LastTrackingUpdateStartDate', params.lastTrackingUpdateStartDate);
    }
    if (params.lastTrackingUpdateEndDate) {
      url.searchParams.set('LastTrackingUpdateEndDate', params.lastTrackingUpdateEndDate);
    }
    if (params.hasTracking != null) {
      url.searchParams.set('HasTracking', String(params.hasTracking));
    }
    if (params.ids?.length) url.searchParams.set('IDs', params.ids.map(String).join(','));
    if (params.referenceIds?.length) {
      url.searchParams.set('ReferenceIds', params.referenceIds.join(','));
    }

    const res = await loggedFetch(url.toString(), {
      integration: 'shipbob',
      operation: 'list_orders',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        shipbob_channel_id: this.opts.channelId,
        Accept: 'application/json',
      },
      onLog: makeOnLog(this.opts.db ?? null),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ShipBob listOrders ${res.status}: ${text.slice(0, 400)}`);
    }

    const body = (await res.json()) as ShipBobOrder[] | { data?: ShipBobOrder[] };
    if (Array.isArray(body)) return body;
    return body.data ?? [];
  }

  /** Batch tracking — max 25 IDs, repeated ShipmentIds= params only. */
  async getShipmentsTracking(shipmentIds: Array<string | number>): Promise<ShipBobTrackingRecord[]> {
    if (shipmentIds.length === 0) return [];
    if (shipmentIds.length > 25) {
      throw new Error('ShipBob Tracking API allows max 25 ShipmentIds per call');
    }

    const url = new URL(`${this.opts.trackingBase.replace(/\/$/, '')}/shipments-tracking`);
    for (const id of shipmentIds) {
      url.searchParams.append('ShipmentIds', String(id));
    }

    const res = await loggedFetch(url.toString(), {
      integration: 'shipbob',
      operation: 'shipments_tracking',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        Accept: 'application/json',
      },
      onLog: makeOnLog(this.opts.db ?? null),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ShipBob shipments-tracking ${res.status}: ${text.slice(0, 400)}`);
    }

    const body = (await res.json()) as ShipBobTrackingRecord[] | { data?: ShipBobTrackingRecord[] };
    if (Array.isArray(body)) return body;
    return body.data ?? [];
  }
}

export function chunkIds<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
