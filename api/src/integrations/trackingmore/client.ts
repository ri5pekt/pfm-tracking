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

export type TrackingMoreCreateItem = {
  tracking_number: string;
  courier_code: string;
};

/** Thrown when TM returns 429 — caller must stop this cycle; wait is already enforced. */
export class TrackingMoreRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs = 120_000) {
    super(message);
    this.name = 'TrackingMoreRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export function isTrackingMoreRateLimitError(err: unknown): err is TrackingMoreRateLimitError {
  return err instanceof TrackingMoreRateLimitError;
}

/**
 * TrackingMore documented limits (V4):
 * - Create / realtime: 3 req/s
 * - Other endpoints (get/update/delete/batch): 10 req/s
 * - On 429: stop and wait exactly 120 seconds before retrying
 */
const REALTIME_MIN_INTERVAL_MS = 350; // ~2.8/s — under 3/s
const STANDARD_MIN_INTERVAL_MS = 110; // ~9/s — under 10/s
const COOLDOWN_MS = 120_000;
export const TM_BATCH_MAX = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class TrackingMoreClient {
  private cooldownUntil = 0;
  private nextRealtimeAt = 0;
  private nextStandardAt = 0;

  constructor(private readonly opts: TrackingMoreClientOptions) {}

  private headers(): Record<string, string> {
    return {
      'Tracking-Api-Key': this.opts.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /** Remaining cooldown ms, or 0 if clear. */
  cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  private async acquire(lane: 'realtime' | 'standard'): Promise<void> {
    const remaining = this.cooldownRemainingMs();
    if (remaining > 0) {
      throw new TrackingMoreRateLimitError(
        `TrackingMore cooldown active — wait ${Math.ceil(remaining / 1000)}s (429 policy)`,
        remaining,
      );
    }
    const now = Date.now();
    const nextAt = lane === 'realtime' ? this.nextRealtimeAt : this.nextStandardAt;
    const wait = Math.max(0, nextAt - now);
    if (wait > 0) await sleep(wait);
    const interval = lane === 'realtime' ? REALTIME_MIN_INTERVAL_MS : STANDARD_MIN_INTERVAL_MS;
    const stamped = Date.now() + interval;
    if (lane === 'realtime') this.nextRealtimeAt = stamped;
    else this.nextStandardAt = stamped;
  }

  private tripCooldown(): void {
    this.cooldownUntil = Date.now() + COOLDOWN_MS;
    console.warn(
      `[trackingmore] 429 received — cooling down ${COOLDOWN_MS / 1000}s before any further calls`,
    );
  }

  private async parseBody(res: Response): Promise<{
    data?: unknown;
    meta?: { code?: number; message?: string };
  }> {
    return (await res.json().catch(() => ({}))) as {
      data?: unknown;
      meta?: { code?: number; message?: string };
    };
  }

  private assertNotRateLimited(res: Response, body: { meta?: { code?: number; message?: string } }): void {
    const metaCode = body.meta?.code;
    if (res.status === 429 || metaCode === 429) {
      this.tripCooldown();
      throw new TrackingMoreRateLimitError(
        `TrackingMore 429: ${body.meta?.message ?? 'rate limited'} — wait 120s`,
        COOLDOWN_MS,
      );
    }
  }

  async detectCourier(trackingNumber: string): Promise<string | null> {
    await this.acquire('realtime');
    const res = await loggedFetch(`${this.opts.apiBase.replace(/\/$/, '')}/couriers/detect`, {
      integration: 'trackingmore',
      operation: 'detect_courier',
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ tracking_number: trackingNumber }),
      onLog: makeOnLog(this.opts.db ?? null),
    });
    const body = await this.parseBody(res);
    this.assertNotRateLimited(res, body);
    if (!res.ok && res.status !== 200) {
      throw new Error(`TrackingMore detect ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
    const data = body.data as Array<{ courier_code?: string }> | undefined;
    return data?.[0]?.courier_code ?? null;
  }

  async createTracking(trackingNumber: string, courierCode: string): Promise<void> {
    await this.acquire('realtime');
    const res = await loggedFetch(`${this.opts.apiBase.replace(/\/$/, '')}/trackings/create`, {
      integration: 'trackingmore',
      operation: 'create_tracking',
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ tracking_number: trackingNumber, courier_code: courierCode }),
      onLog: makeOnLog(this.opts.db ?? null),
    });
    const body = await this.parseBody(res);
    this.assertNotRateLimited(res, body);
    const code = body.meta?.code ?? res.status;
    if (code === 200 || code === 201) return;
    // already exists variants
    if (res.status === 400 || code === 4016 || code === 4031 || code === 4101) return;
    if (!res.ok) {
      throw new Error(`TrackingMore create ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
  }

  /**
   * Batch create — max 40 per call (POST /trackings/batch).
   * Counts as a standard (non-realtime) request.
   */
  async createTrackingsBatch(items: TrackingMoreCreateItem[]): Promise<{
    success: Array<{ id?: string; tracking_number?: string; courier_code?: string }>;
    error: Array<{
      tracking_number?: string;
      errorCode?: string | number;
      errorMessage?: string;
    }>;
  }> {
    if (items.length === 0) return { success: [], error: [] };
    if (items.length > TM_BATCH_MAX) {
      throw new Error(`TrackingMore batch create allows max ${TM_BATCH_MAX} items`);
    }
    await this.acquire('standard');
    const res = await loggedFetch(`${this.opts.apiBase.replace(/\/$/, '')}/trackings/batch`, {
      integration: 'trackingmore',
      operation: 'batch_create_trackings',
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(items),
      onLog: makeOnLog(this.opts.db ?? null),
    });
    const body = await this.parseBody(res);
    this.assertNotRateLimited(res, body);
    const data = (body.data ?? {}) as {
      success?: Array<{ id?: string; tracking_number?: string; courier_code?: string }>;
      error?: Array<{
        tracking_number?: string;
        errorCode?: string | number;
        errorMessage?: string;
      }>;
    };
    // 200 even when some items error (already exists, etc.)
    if (!res.ok && (body.meta?.code ?? res.status) !== 200) {
      throw new Error(`TrackingMore batch ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
    }
    return { success: data.success ?? [], error: data.error ?? [] };
  }

  /** Get one tracking. Returns null if not registered (4102) or empty. */
  async getTracking(trackingNumber: string): Promise<TrackingMoreTracking | null> {
    const map = await this.getTrackings([trackingNumber]);
    return map.get(trackingNumber) ?? null;
  }

  /**
   * Get up to 40 trackings in one call (comma-separated tracking_numbers).
   * Missing / 4102 numbers are omitted from the map (not thrown).
   */
  async getTrackings(trackingNumbers: string[]): Promise<Map<string, TrackingMoreTracking>> {
    const out = new Map<string, TrackingMoreTracking>();
    const unique = [...new Set(trackingNumbers.map((t) => t.trim()).filter(Boolean))];
    if (unique.length === 0) return out;
    if (unique.length > TM_BATCH_MAX) {
      throw new Error(`TrackingMore get allows max ${TM_BATCH_MAX} tracking_numbers`);
    }

    await this.acquire('standard');
    const url = new URL(`${this.opts.apiBase.replace(/\/$/, '')}/trackings/get`);
    url.searchParams.set('tracking_numbers', unique.join(','));

    const res = await loggedFetch(url.toString(), {
      integration: 'trackingmore',
      operation: 'get_tracking',
      headers: this.headers(),
      onLog: makeOnLog(this.opts.db ?? null),
    });
    const body = await this.parseBody(res);
    this.assertNotRateLimited(res, body);

    const metaCode = body.meta?.code ?? res.status;
    // Single-number "not exists" often comes as 400 / 4102
    if (metaCode === 4102 || (res.status === 400 && metaCode === 4102)) {
      return out;
    }
    if (!res.ok) {
      throw new Error(`TrackingMore get ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }

    const data = body.data;
    const list: TrackingMoreTracking[] = Array.isArray(data)
      ? data
      : data
        ? [data as TrackingMoreTracking]
        : [];
    for (const t of list) {
      const tn = t.tracking_number?.trim();
      if (tn) out.set(tn, t);
    }
    return out;
  }

  /** Only works for expired / notfound trackings. */
  async retrackById(id: string): Promise<void> {
    await this.acquire('standard');
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
    const body = await this.parseBody(res);
    this.assertNotRateLimited(res, body);
    const code = body.meta?.code ?? res.status;
    if (code === 200 || code === 201) return;
    if (code === 4113 || res.status === 400) return;
    if (!res.ok) {
      throw new Error(`TrackingMore retrack ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
  }

  async ensureAndGet(
    trackingNumber: string,
    preferredCourier?: string | null,
  ): Promise<TrackingMoreTracking | null> {
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
      if (isTrackingMoreRateLimitError(err)) throw err;
      console.warn(`[trackingmore] create failed for ${trackingNumber}:`, err);
    }
    // Brief pause so TM can index the new tracking (not a rate-limit wait)
    await sleep(400);
    return this.getTracking(trackingNumber);
  }
}

export function trackingMoreCheckpoints(t: TrackingMoreTracking): TrackingMoreCheckpoint[] {
  return t.origin_info?.trackinfo ?? t.destination_info?.trackinfo ?? t.trackinfo ?? [];
}

export function parseTrackingMoreDate(value: string | undefined): Date | null {
  if (!value) return null;
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function courierHintForShipment(
  trackingNumber: string,
  carrierCode: string | null | undefined,
  looksLikeDhl: (tn: string) => boolean,
): string {
  if (carrierCode === 'dhl_ecs' || looksLikeDhl(trackingNumber)) return 'dhlglobalmail';
  if (carrierCode === 'usps') return 'usps';
  if (carrierCode && /dhl/i.test(carrierCode)) return 'dhlglobalmail';
  return carrierCode && carrierCode !== 'unknown' ? carrierCode : 'dhlglobalmail';
}
