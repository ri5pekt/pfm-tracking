import type { Db } from '../db/pool.js';

export type ReconcileResult = {
  openWithoutTracking: number;
  openStaleNoEvents: number;
  orphanAggregatorIds: number;
  unmappedStatusPairs: number;
  findings: Array<{ kind: string; detail: string; n: number }>;
};

/**
 * Daily reconcile — surfaces data-quality issues for the parallel-run / ops dashboard.
 * Does not mutate shipment status (except reporting counts).
 */
export async function runDailyReconcile(db: Db): Promise<ReconcileResult> {
  const findings: ReconcileResult['findings'] = [];

  const noTn = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM shipments
     WHERE internal_status NOT IN ('DELIVERED','CANCELLED','RETURNED_TO_SENDER')
       AND (tracking_number IS NULL OR tracking_number = '')`,
  );
  const openWithoutTracking = Number(noTn.rows[0]?.n ?? 0);
  if (openWithoutTracking) {
    findings.push({
      kind: 'open_without_tracking',
      detail: 'Open shipments missing tracking number',
      n: openWithoutTracking,
    });
  }

  const stale = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM shipments s
     WHERE s.internal_status NOT IN ('DELIVERED','CANCELLED','RETURNED_TO_SENDER')
       AND s.tracking_number IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tracking_events te WHERE te.shipment_id = s.id)
       AND s.created_at < now() - interval '2 days'`,
  );
  const openStaleNoEvents = Number(stale.rows[0]?.n ?? 0);
  if (openStaleNoEvents) {
    findings.push({
      kind: 'open_stale_no_events',
      detail: 'Open tracked shipments with zero events for >2 days',
      n: openStaleNoEvents,
    });
  }

  const orphans = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM shipments
     WHERE aggregator = 'trackingmore'
       AND aggregator_id IS NOT NULL
       AND tracking_number IS NULL`,
  );
  const orphanAggregatorIds = Number(orphans.rows[0]?.n ?? 0);
  if (orphanAggregatorIds) {
    findings.push({
      kind: 'orphan_aggregator',
      detail: 'TrackingMore aggregator_id without tracking number',
      n: orphanAggregatorIds,
    });
  }

  const unmapped = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT DISTINCT te.source, te.raw_status
       FROM tracking_events te
       WHERE te.received_at > now() - interval '14 days'
         AND te.raw_status IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM status_mappings sm
           WHERE sm.source = te.source
             AND sm.raw_status = te.raw_status
             AND (
               sm.raw_substatus_code IS NULL
               OR sm.raw_substatus_code = ''
               OR sm.raw_substatus_code = te.raw_substatus_code
             )
         )
     ) x`,
  );
  const unmappedStatusPairs = Number(unmapped.rows[0]?.n ?? 0);
  if (unmappedStatusPairs) {
    findings.push({
      kind: 'unmapped_statuses',
      detail: 'Distinct source/raw_status pairs without status_mappings (14d)',
      n: unmappedStatusPairs,
    });
  }

  return {
    openWithoutTracking,
    openStaleNoEvents,
    orphanAggregatorIds,
    unmappedStatusPairs,
    findings,
  };
}

export async function listUnmappedStatuses(
  db: Db,
  opts?: { days?: number; limit?: number },
): Promise<
  Array<{
    source: string;
    raw_status: string;
    raw_substatus_code: string | null;
    n: number;
    sample_description: string | null;
  }>
> {
  const days = opts?.days ?? 14;
  const limit = opts?.limit ?? 100;
  const { rows } = await db.query<{
    source: string;
    raw_status: string;
    raw_substatus_code: string | null;
    n: string;
    sample_description: string | null;
  }>(
    `SELECT te.source, te.raw_status, te.raw_substatus_code,
            count(*)::text AS n,
            max(te.description) AS sample_description
     FROM tracking_events te
     WHERE te.received_at > now() - ($1::text || ' days')::interval
       AND te.raw_status IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM status_mappings sm
         WHERE sm.source = te.source
           AND sm.raw_status = te.raw_status
           AND (
             sm.raw_substatus_code IS NULL
             OR sm.raw_substatus_code = ''
             OR sm.raw_substatus_code = te.raw_substatus_code
           )
       )
     GROUP BY 1, 2, 3
     ORDER BY count(*) DESC
     LIMIT $2`,
    [String(days), limit],
  );
  return rows.map((r) => ({
    source: r.source,
    raw_status: r.raw_status,
    raw_substatus_code: r.raw_substatus_code,
    n: Number(r.n),
    sample_description: r.sample_description,
  }));
}
