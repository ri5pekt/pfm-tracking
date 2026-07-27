import type { Db } from '../../db/pool.js';
import { loggedFetch, makeOnLog } from '../log.js';

export type KlaviyoClientOptions = {
  apiKey: string;
  apiBase?: string;
  revision?: string;
  db?: Db | null;
};

export type KlaviyoCreateEventInput = {
  metricName: string;
  email: string;
  properties: Record<string, unknown>;
  uniqueId: string;
  time?: string;
};

/**
 * Klaviyo Events API (server) — POST /api/events/
 * https://developers.klaviyo.com/en/reference/create_event
 */
export class KlaviyoClient {
  private readonly apiBase: string;
  private readonly revision: string;

  constructor(private readonly opts: KlaviyoClientOptions) {
    this.apiBase = (opts.apiBase ?? 'https://a.klaviyo.com').replace(/\/$/, '');
    this.revision = opts.revision ?? '2024-10-15';
  }

  async createEvent(input: KlaviyoCreateEventInput): Promise<void> {
    const body = {
      data: {
        type: 'event',
        attributes: {
          properties: input.properties,
          time: input.time ?? new Date().toISOString(),
          unique_id: input.uniqueId,
          metric: {
            data: {
              type: 'metric',
              attributes: { name: input.metricName },
            },
          },
          profile: {
            data: {
              type: 'profile',
              attributes: { email: input.email },
            },
          },
        },
      },
    };

    const res = await loggedFetch(`${this.apiBase}/api/events/`, {
      integration: 'klaviyo',
      operation: 'create_event',
      method: 'POST',
      headers: {
        Authorization: `Klaviyo-API-Key ${this.opts.apiKey}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        revision: this.revision,
      },
      body: JSON.stringify(body),
      onLog: makeOnLog(this.opts.db ?? null),
    });

    // 202 Accepted is success for create event
    if (res.status === 202 || res.status === 200 || res.status === 201) return;

    const text = await res.text().catch(() => '');
    throw new Error(`Klaviyo create_event ${res.status}: ${text.slice(0, 400)}`);
  }
}

/** Friendly metric names for Klaviyo flows (custom metrics). */
export function klaviyoMetricName(eventType: string): string {
  switch (eventType) {
    case 'shipment.shipped':
      return 'PFM Shipment Shipped';
    case 'shipment.out_for_delivery':
      return 'PFM Shipment Out For Delivery';
    case 'shipment.delivered':
      return 'PFM Shipment Delivered';
    case 'shipment.delivery_attempt_failed':
      return 'PFM Shipment Delivery Attempt Failed';
    case 'shipment.exception':
      return 'PFM Shipment Exception';
    case 'shipment.stalled':
      return 'PFM Shipment Stalled';
    default:
      return eventType;
  }
}
