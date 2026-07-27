import type { Db } from '../../db/pool.js';
import { loggedFetch, makeOnLog } from '../log.js';

export type KlbClientOptions = {
  /** Base like https://app.zenventory.com/rest — legacy shippingorders uses /services/rest */
  apiBase: string;
  legacySecureKey: string;
  db?: Db | null;
};

export type KlbShipment = {
  shipmentid?: number;
  trackingnumber?: string;
  shippeddate?: string;
  cancelled?: boolean;
  carrier?: { code?: string | null; name?: string | null };
  service?: { code?: string | null; name?: string | null };
};

export type KlbShippingOrder = {
  shippingorderid?: number;
  customerorder?: {
    customerorderid?: number;
    ordernumber?: string;
  };
  customer?: {
    customerid?: number;
    name?: string;
    surname?: string;
  };
  shippingaddress?: {
    city?: string;
    country?: string;
    state?: string;
    zip?: string;
    phone?: string;
    name?: string;
  };
  carrier?: { code?: string | null; name?: string | null };
  service?: { code?: string | null; name?: string | null };
  ordereddate?: string;
  shipped?: boolean;
  shippeddate?: string;
  shipments?: KlbShipment[];
};

function legacyBase(apiBase: string): string {
  if (apiBase.includes('/services/rest')) return apiBase.replace(/\/$/, '');
  return apiBase.replace(/\/rest\/?$/, '/services/rest');
}

export class KlbClient {
  constructor(private readonly opts: KlbClientOptions) {}

  async listShippingOrders(params: {
    startDate: string;
    endDate: string;
  }): Promise<KlbShippingOrder[]> {
    const base = legacyBase(this.opts.apiBase);
    const url = new URL(`${base}/shippingorders`);
    url.searchParams.set('shipped', 'true');
    url.searchParams.set('include_shipments', 'true');
    url.searchParams.set('start_date', params.startDate);
    url.searchParams.set('end_date', params.endDate);

    const res = await loggedFetch(url.toString(), {
      integration: 'klb',
      operation: 'list_shipping_orders',
      headers: {
        Accept: 'application/json',
        SecureKey: this.opts.legacySecureKey,
      },
      onLog: makeOnLog(this.opts.db ?? null),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`KLB shippingorders ${res.status}: ${text.slice(0, 400)}`);
    }

    const body = (await res.json()) as KlbShippingOrder[] | { shippingOrders?: KlbShippingOrder[] };
    if (Array.isArray(body)) return body;
    return body.shippingOrders ?? [];
  }
}

export function klbTrackingNumber(s: KlbShipment): string | null {
  const n = s.trackingnumber;
  return n && String(n).trim() ? String(n).trim() : null;
}

/** Prefer DHL eCommerce-style numbers (discovery: ~88% of KLB). */
export function looksLikeDhlEcommerce(tracking: string): boolean {
  return /^20\d{6}.+/i.test(tracking);
}

export function klbCarrierName(order: KlbShippingOrder, shipment?: KlbShipment): string | null {
  const name = shipment?.carrier?.name || order.carrier?.name || shipment?.carrier?.code || order.carrier?.code;
  return name && String(name).trim() ? String(name).trim() : null;
}
