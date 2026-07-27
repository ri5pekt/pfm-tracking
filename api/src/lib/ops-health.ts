/**
 * Ops health for Phase 4/5 monitoring.
 * Alert when a watched job lags > 2× its schedule interval (docs/dev-plan.md §9).
 */

export type WatchedJob = {
  name: string;
  /** Expected schedule interval in milliseconds */
  intervalMs: number;
  /** If true, lagging/failing this job makes /health/ops return 503 */
  critical: boolean;
};

/** Matches worker/src/index.ts schedules */
export const WATCHED_JOBS: WatchedJob[] = [
  { name: 'shipbob.orders.sync', intervalMs: 20 * 60 * 1000, critical: true },
  { name: 'shipbob.tracking.poll', intervalMs: 20 * 60 * 1000, critical: true },
  { name: 'klb.sync', intervalMs: 20 * 60 * 1000, critical: true },
  { name: 'trackingmore.poll', intervalMs: 15 * 60 * 1000, critical: true },
  { name: 'stalled.detect', intervalMs: 24 * 60 * 60 * 1000, critical: false },
  { name: 'reconcile.daily', intervalMs: 24 * 60 * 60 * 1000, critical: false },
  { name: 'retention.scrub', intervalMs: 24 * 60 * 60 * 1000, critical: false },
];

export type JobHealthStatus = 'ok' | 'lagging' | 'missing' | 'failed_recent';

export type JobHealth = {
  jobName: string;
  critical: boolean;
  intervalMs: number;
  lagThresholdMs: number;
  status: JobHealthStatus;
  lastSuccessAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: string | null;
  lagMs: number | null;
};

export type OpsHealth = {
  ok: boolean;
  checkedAt: string;
  jobs: JobHealth[];
  recentFailures: number;
  alerts: string[];
};

export function lagThresholdMs(intervalMs: number): number {
  return intervalMs * 2;
}

export function evaluateJobHealth(
  job: WatchedJob,
  input: {
    lastSuccessAt: Date | null;
    lastFinishedAt: Date | null;
    lastStatus: string | null;
    now?: Date;
  },
): JobHealth {
  const now = input.now ?? new Date();
  const threshold = lagThresholdMs(job.intervalMs);
  const lastSuccessAt = input.lastSuccessAt;
  const lagMs = lastSuccessAt ? now.getTime() - lastSuccessAt.getTime() : null;

  let status: JobHealthStatus = 'ok';
  if (input.lastStatus === 'failed' && input.lastFinishedAt) {
    const age = now.getTime() - input.lastFinishedAt.getTime();
    if (age <= threshold) status = 'failed_recent';
  }
  if (status === 'ok') {
    if (!lastSuccessAt) status = 'missing';
    else if (lagMs !== null && lagMs > threshold) status = 'lagging';
  }

  return {
    jobName: job.name,
    critical: job.critical,
    intervalMs: job.intervalMs,
    lagThresholdMs: threshold,
    status,
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    lastFinishedAt: input.lastFinishedAt?.toISOString() ?? null,
    lastStatus: input.lastStatus,
    lagMs,
  };
}

export function buildOpsHealth(
  jobs: JobHealth[],
  recentFailures: number,
  now: Date = new Date(),
): OpsHealth {
  const alerts: string[] = [];
  for (const j of jobs) {
    if (j.status === 'ok') continue;
    const label = j.critical ? 'critical' : 'info';
    if (j.status === 'missing') {
      alerts.push(`[${label}] ${j.jobName}: never succeeded`);
    } else if (j.status === 'lagging') {
      const mins = Math.round((j.lagMs ?? 0) / 60000);
      alerts.push(`[${label}] ${j.jobName}: lag ${mins}m (threshold ${j.lagThresholdMs / 60000}m)`);
    } else if (j.status === 'failed_recent') {
      alerts.push(`[${label}] ${j.jobName}: recent failed run`);
    }
  }
  if (recentFailures > 0) {
    alerts.push(`[info] ${recentFailures} failed ingestion_runs in last 2h`);
  }

  const criticalBad = jobs.some(
    (j) => j.critical && (j.status === 'lagging' || j.status === 'failed_recent'),
  );
  // Fresh install: missing critical jobs alone → ok for /health/ops (warn on dashboard)
  const ok = !criticalBad;

  return {
    ok,
    checkedAt: now.toISOString(),
    jobs,
    recentFailures,
    alerts,
  };
}
