import type { Db } from '../db/pool.js';
import {
  WATCHED_JOBS,
  buildOpsHealth,
  evaluateJobHealth,
  evaluateTrackingCoverage,
  type OpsHealth,
} from '../lib/ops-health.js';

export async function collectOpsHealth(db: Db): Promise<OpsHealth> {
  const now = new Date();
  const jobs = [];

  for (const watched of WATCHED_JOBS) {
    const { rows } = await db.query<{
      finished_at: Date | null;
      status: string;
    }>(
      `SELECT finished_at, status
       FROM ingestion_runs
       WHERE job_name = $1 AND finished_at IS NOT NULL
       ORDER BY finished_at DESC
       LIMIT 1`,
      [watched.name],
    );

    const last = rows[0] ?? null;
    const success = await db.query<{ finished_at: Date }>(
      `SELECT finished_at
       FROM ingestion_runs
       WHERE job_name = $1 AND status IN ('success', 'partial') AND finished_at IS NOT NULL
       ORDER BY finished_at DESC
       LIMIT 1`,
      [watched.name],
    );

    const cursor = await db.query<{ last_success_at: Date | null }>(
      `SELECT last_success_at FROM sync_cursors WHERE job_name = $1`,
      [watched.name],
    );

    const lastSuccessAt =
      success.rows[0]?.finished_at ?? cursor.rows[0]?.last_success_at ?? null;

    jobs.push(
      evaluateJobHealth(watched, {
        lastSuccessAt,
        lastFinishedAt: last?.finished_at ?? null,
        lastStatus: last?.status ?? null,
        now,
      }),
    );
  }

  const failures = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ingestion_runs
     WHERE status = 'failed' AND started_at > now() - interval '2 hours'`,
  );

  // COALESCE(last_polled_at, created_at) treats a never-polled shipment as stale only once it's
  // actually old enough to have been missed — a shipment created 2 minutes ago isn't a bug.
  const coverage = await db.query<{ n: string; oldest: Date | null }>(
    `SELECT count(*)::text AS n, min(COALESCE(last_polled_at, created_at)) AS oldest
     FROM shipments
     WHERE aggregator = 'trackingmore'
       AND tracking_number IS NOT NULL
       AND internal_status NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER')
       AND COALESCE(last_polled_at, created_at) < now() - interval '2 hours'`,
  );
  const trackingCoverage = evaluateTrackingCoverage({
    staleCount: Number(coverage.rows[0]?.n ?? 0),
    oldestUnpolledAt: coverage.rows[0]?.oldest ?? null,
    now,
  });

  return buildOpsHealth(jobs, Number(failures.rows[0]?.n ?? 0), now, trackingCoverage);
}
