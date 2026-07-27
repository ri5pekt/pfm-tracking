import type { Db } from '../../db/pool.js';
import { loggedFetch, makeOnLog } from '../log.js';

export type TrackingMoreClientOptions = {
  apiKey: string;
  apiBase: string;
  db?: Db | null;
};

export type TrackingMoreCheckpoint = {
  checkpoint_date?: string;
  tracking_detail?: string;
  location?: string;
  checkpoint_delivery_status?: string;
  checkpoint_delivery_substatus?: string;
  substatus?: string;
};

export type TrackingMoreTracking = {
  id?: string | number;
  tracking_number?: string;
  courier_code?: string;
  delivery_status?: string;
  origin_info?: { trackinfo?: TrackingMoreCheckpoint[] };
  destination_info?: { trackinfo?: TrackingMoreCheckpoint[] };
  trackinfo?: TrackingMoreCheckpoint[];
};

export class TrackingMoreClient {
  constructor(private readonly opts: TrackingMoreClientOptions) {}

  private headers(): Record<string, string> {
    return {
      'Tracking-Api-Key': this.opts.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async detectCourier(trackingNumber: string): Promise<string | null> {
    const res = await loggedFetch(`${this.opts.apiBase.replace(/\/$/, '')}/couriers/detect`, {
      integration: 'trackingmore',
      operation: 'detect_courier',
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ tracking_number: trackingNumber }),
      onLog: makeOnLog(this.opts.db ?? null),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: Array<{ courier_code?: string }>;
      meta?: { code?: number; message?: string };
    };
    if (!res.ok && res.status !== 200) {
      throw new Error(`TrackingMore detect ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
    return body.data?.[0]?.courier_code ?? null;
  }

  async createTracking(trackingNumber: string, courierCode: string): Promise<void> {
    const res = await loggedFetch(`${this.opts.apiBase.replace(/\/$/, '')}/trackings/create`, {
      integration: 'trackingmore',
      operation: 'create_tracking',
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ tracking_number: trackingNumber, courier_code: courierCode }),
      onLog: makeOnLog(this.opts.db ?? null),
    });
    const body = (await res.json().catch(() => ({}))) as {
      meta?: { code?: number; message?: string };
    };
    // 200 / 201 success; 400 often means already exists — treat as ok
    const code = body.meta?.code ?? res.status;
    if (code === 200 || code === 201) return;
    if (res.status === 400 || code === 4016 || code === 4031) return; // already exists variants
    if (!res.ok) {
      throw new Error(`TrackingMore create ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
  }

  async getTracking(trackingNumber: string): Promise<TrackingMoreTracking | null> {
    const url = new URL(`${this.opts.apiBase.replace(/\/$/, '')}/trackings/get`);
    url.searchParams.set('tracking_numbers', trackingNumber);

    const res = await loggedFetch(url.toString(), {
      integration: 'trackingmore',
      operation: 'get_tracking',
      headers: this.headers(),
      onLog: makeOnLog(this.opts.db ?? null),
    });

    const body = (await res.json().catch(() => ({}))) as {
      data?: TrackingMoreTracking | TrackingMoreTracking[];
      meta?: { code?: number; message?: string };
    };

    if (!res.ok) {
      throw new Error(`TrackingMore get ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }

    const data = body.data;
    if (!data) return null;
    if (Array.isArray(data)) return data[0] ?? null;
    return data;
  }

  /** Only works for expired / notfound trackings. */
  async retrackById(id: string): Promise<void> {
    const res = await loggedFetch(
      `${this.opts.apiBase.replace(/\/$/, '')}/trackings/retrack/${encodeURIComponent(id)}`,
      {
        integration: 'trackingmore',
        operation: 'retrack',
        method: 'POST',
        headers: this.headers(),
        onLog: makeOnLog(this.opts.db ?? null),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      meta?: { code?: number; message?: string };
    };
    const code = body.meta?.code ?? res.status;
    if (code === 200 || code === 201) return;
    // 4113 = retrack not allowed (still active) — treat as soft no-op
    if (code === 4113 || res.status === 400) return;
    if (!res.ok) {
      throw new Error(`TrackingMore retrack ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
  }

  async ensureAndGet(trackingNumber: string, preferredCourier?: string | null): Promise<TrackingMoreTracking | null> {
    let courier = preferredCourier ?? null;
    if (!courier) {
      courier = await this.detectCourier(trackingNumber);
    }
    if (!courier) {
      courier = 'dhlglobalmail';
    }
    try {
      await this.createTracking(trackingNumber, courier);
    } catch (err) {
      console.warn(`[trackingmore] create failed for ${trackingNumber}:`, err);
    }
    await new Promise((r) => setTimeout(r, 800));
    return this.getTracking(trackingNumber);
  }
}

export function trackingMoreCheckpoints(t: TrackingMoreTracking): TrackingMoreCheckpoint[] {
  return (
    t.origin_info?.trackinfo ??
    t.destination_info?.trackinfo ??
    t.trackinfo ??
    []
  );
}

export function parseTrackingMoreDate(value: string | undefined): Date | null {
  if (!value) return null;
  // "2026-07-15 10:00:00" — treat as UTC if no TZ
  const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}
