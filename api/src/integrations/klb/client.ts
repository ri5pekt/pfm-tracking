import type { Db } from '../../db/pool.js';
import { loggedFetch, makeOnLog } from '../log.js';

export type KlbClientOptions = {
  /** Base like https://app.zenventory.com/rest — legacy shippingorders uses /services/rest */
  apiBase: string;
  legacySecureKey: string;
  /** Basic-auth credentials for the modern REST API (customer-orders email lookup only). */
  apiKey?: string | null;
  apiSecret?: string | null;
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
    return this.listShippingOrdersRaw({ startDate: params.startDate, endDate: params.endDate });
  }

  /**
   * `customer-orders` is a *separate* Zenventory resource from `shippingorders` — it has no
   * shipment/tracking data at all, but it's the only place customer email lives (confirmed live,
   * docs/research/warehouse-api-discovery.md + plans/klb-customer-email-backfill.md). Soft-fails
   * (returns null) on any error — this is a best-effort enrichment lookup and must never break
   * the main shipment ingestion path.
   */
  async getCustomerOrder(orderNumber: string): Promise<{
    email: string | null;
    postcode: string | null;
    orderedAt: Date | null;
    items: Array<{ sku: string; quantity: number; title: string | null }>;
  } | null> {
    if (!this.opts.apiKey || !this.opts.apiSecret) return null;

    try {
      const base = this.opts.apiBase.replace(/\/$/, '');
      const url = new URL(`${base}/customer-orders`);
      url.searchParams.set('orderNumber', orderNumber);
      const auth = Buffer.from(`${this.opts.apiKey}:${this.opts.apiSecret}`).toString('base64');

      const res = await loggedFetch(url.toString(), {
        integration: 'klb',
        operation: 'get_customer_order_email',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${auth}`,
        },
        onLog: makeOnLog(this.opts.db ?? null),
      });
      if (!res.ok) return null;

      const body = (await res.json()) as {
        customerOrders?: Array<{
          orderDate?: string | null;
          orderedDate?: string | null;
          created?: string | null;
          customer?: { email?: string | null };
          shippingAddress?: { zip?: string | null; postalCode?: string | null };
          items?: Array<{
            sku?: string | null;
            quantity?: number | null;
            orderQuantity?: number | null;
            description?: string | null;
          }>;
        }>;
      };
      const row = body.customerOrders?.[0];
      if (!row) return null;
      const email = row.customer?.email?.trim() || null;
      const postcode = row.shippingAddress?.zip?.trim() || row.shippingAddress?.postalCode?.trim() || null;
      const rawDate = row.orderDate || row.orderedDate || row.created || null;
      const orderedAt = rawDate ? new Date(rawDate.includes(' ') ? rawDate.replace(' ', 'T') + 'Z' : rawDate) : null;
      const items = (row.items ?? [])
        .map((item) => ({
          sku: String(item.sku ?? '').trim(),
          quantity: Number(item.quantity ?? item.orderQuantity ?? 1) || 1,
          title: item.description?.trim() || null,
        }))
        .filter((item) => item.sku);
      return {
        email,
        postcode,
        orderedAt: orderedAt && !Number.isNaN(orderedAt.getTime()) ? orderedAt : null,
        items,
      };
    } catch {
      return null;
    }
  }

  async getCustomerOrderEmail(orderNumber: string): Promise<string | null> {
    const row = await this.getCustomerOrder(orderNumber);
    return row?.email ?? null;
  }

  /**
   * Targeted lookup for on-demand hydrate. Always bounded by customer-orders.orderDate —
   * never scans shippingorders without a date window (the API may ignore unknown filters).
   */
  async findShippingOrdersByOrderNumber(orderNumber: string): Promise<KlbShippingOrder[]> {
    const wanted = orderNumber.trim();
    if (!wanted) return [];

    const detail = await this.getCustomerOrder(wanted);
    if (!detail?.orderedAt) return [];

    const start = new Date(detail.orderedAt);
    start.setUTCDate(start.getUTCDate() - 2);
    const end = new Date(detail.orderedAt);
    end.setUTCDate(end.getUTCDate() + 21);
    const window = await this.listShippingOrdersRaw({
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      ordernumber: wanted,
    });
    return window.filter((o) => {
      const n = String(o.customerorder?.ordernumber ?? o.customerorder?.customerorderid ?? '');
      return n === wanted;
    });
  }

  private async listShippingOrdersRaw(params: {
    startDate?: string;
    endDate?: string;
    ordernumber?: string;
  }): Promise<KlbShippingOrder[]> {
    const base = legacyBase(this.opts.apiBase);
    const url = new URL(`${base}/shippingorders`);
    url.searchParams.set('shipped', 'true');
    url.searchParams.set('include_shipments', 'true');
    if (params.startDate) url.searchParams.set('start_date', params.startDate);
    if (params.endDate) url.searchParams.set('end_date', params.endDate);
    if (params.ordernumber) url.searchParams.set('ordernumber', params.ordernumber);

    const res = await loggedFetch(url.toString(), {
      integration: 'klb',
      operation: params.ordernumber ? 'get_shipping_order' : 'list_shipping_orders',
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
