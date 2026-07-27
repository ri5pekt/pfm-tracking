import type { Db } from '../db/pool.js';
import {
  WATCHED_JOBS,
  buildOpsHealth,
  evaluateJobHealth,
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

  return buildOpsHealth(jobs, Number(failures.rows[0]?.n ?? 0), now);
}
