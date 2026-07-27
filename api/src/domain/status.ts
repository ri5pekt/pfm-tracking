import type { Db } from '../db/pool.js';

export type StatusMapping = {
  source: string;
  raw_status: string;
  raw_substatus_code: string | null;
  internal_status: string;
  status_rank: number;
};

export type MappedStatus = {
  internalStatus: string;
  statusRank: number;
};

const TERMINAL = new Set(['DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER']);

const FALLBACK_BY_RAW: Record<string, MappedStatus> = {
  PreTransit: { internalStatus: 'LABEL_CREATED', statusRank: 30 },
  InTransit: { internalStatus: 'IN_TRANSIT', statusRank: 40 },
  OutForDelivery: { internalStatus: 'OUT_FOR_DELIVERY', statusRank: 50 },
  AvailableForPickup: { internalStatus: 'OUT_FOR_DELIVERY', statusRank: 50 },
  DeliveryAttemptFailed: { internalStatus: 'EXCEPTION', statusRank: 55 },
  DeliveryException: { internalStatus: 'EXCEPTION', statusRank: 55 },
  Exception: { internalStatus: 'EXCEPTION', statusRank: 55 },
  Delivered: { internalStatus: 'DELIVERED', statusRank: 90 },
  // TrackingMore delivery_status values
  pending: { internalStatus: 'LABEL_CREATED', statusRank: 30 },
  notfound: { internalStatus: 'LABEL_CREATED', statusRank: 30 },
  transit: { internalStatus: 'IN_TRANSIT', statusRank: 40 },
  pickup: { internalStatus: 'OUT_FOR_DELIVERY', statusRank: 50 },
  undelivered: { internalStatus: 'EXCEPTION', statusRank: 55 },
  exception: { internalStatus: 'EXCEPTION', statusRank: 55 },
  expired: { internalStatus: 'EXCEPTION', statusRank: 55 },
  delivered: { internalStatus: 'DELIVERED', statusRank: 90 },
};

export async function loadStatusMappings(db: Db): Promise<StatusMapping[]> {
  const { rows } = await db.query<StatusMapping>(
    `SELECT source, raw_status, raw_substatus_code, internal_status, status_rank
     FROM status_mappings`,
  );
  return rows;
}

export function mapRawStatus(
  mappings: StatusMapping[],
  input: {
    source: 'shipbob' | 'trackingmore' | 'system';
    rawStatus: string;
    rawSubstatusCode?: string | null;
  },
): MappedStatus {
  const exact = mappings.find(
    (m) =>
      m.source === input.source &&
      m.raw_status === input.rawStatus &&
      (m.raw_substatus_code ?? '') === (input.rawSubstatusCode ?? ''),
  );
  if (exact) {
    return { internalStatus: exact.internal_status, statusRank: exact.status_rank };
  }

  const base = mappings.find(
    (m) =>
      m.source === input.source &&
      m.raw_status === input.rawStatus &&
      (m.raw_substatus_code == null || m.raw_substatus_code === ''),
  );
  if (base) {
    return { internalStatus: base.internal_status, statusRank: base.status_rank };
  }

  const fallback = FALLBACK_BY_RAW[input.rawStatus] ?? FALLBACK_BY_RAW[input.rawStatus.toLowerCase()];
  if (fallback) return fallback;

  // Unmapped: keep as IN_TRANSIT so we never silently drop
  return { internalStatus: 'IN_TRANSIT', statusRank: 40 };
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

/** Apply sticky terminals: once delivered/cancelled/RTS, do not regress. */
export function applyStickyTerminal(
  current: MappedStatus | null,
  next: MappedStatus,
): MappedStatus {
  if (current && isTerminalStatus(current.internalStatus)) {
    return current;
  }
  return next;
}
