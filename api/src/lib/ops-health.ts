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

/**
 * Separate from job-run health: a job can report `success` every cycle while still failing to
 * make progress on specific rows (see trackingmore.poll starvation — docs/dev-plan.md incident
 * 2026-08-10). Tracks whether every open TrackingMore shipment has been examined recently,
 * regardless of whether the job that's supposed to touch it is reporting healthy.
 */
export type TrackingCoverageStatus = 'ok' | 'stale';

export type TrackingCoverageHealth = {
  status: TrackingCoverageStatus;
  staleCount: number;
  oldestGapMs: number | null;
  thresholdMs: number;
};

export const TRACKING_COVERAGE_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export function evaluateTrackingCoverage(input: {
  staleCount: number;
  oldestUnpolledAt: Date | null;
  now?: Date;
  thresholdMs?: number;
}): TrackingCoverageHealth {
  const now = input.now ?? new Date();
  const thresholdMs = input.thresholdMs ?? TRACKING_COVERAGE_STALE_THRESHOLD_MS;
  const oldestGapMs = input.oldestUnpolledAt
    ? now.getTime() - input.oldestUnpolledAt.getTime()
    : null;
  const status: TrackingCoverageStatus =
    input.staleCount > 0 && oldestGapMs !== null && oldestGapMs > thresholdMs ? 'stale' : 'ok';
  return { status, staleCount: input.staleCount, oldestGapMs, thresholdMs };
}

export type OpsHealth = {
  ok: boolean;
  checkedAt: string;
  jobs: JobHealth[];
  recentFailures: number;
  trackingCoverage: TrackingCoverageHealth;
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
  trackingCoverage?: TrackingCoverageHealth,
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

  const coverage: TrackingCoverageHealth =
    trackingCoverage ?? evaluateTrackingCoverage({ staleCount: 0, oldestUnpolledAt: null, now });
  if (coverage.status === 'stale') {
    const hours = coverage.oldestGapMs ? Math.round((coverage.oldestGapMs / 3600000) * 10) / 10 : 0;
    alerts.push(
      `[critical] trackingmore.poll coverage: ${coverage.staleCount} shipment(s) unpolled for ${hours}h+ ` +
        `(job may report success while starving specific rows — see poll.ts ordering)`,
    );
  }

  const criticalBad = jobs.some(
    (j) => j.critical && (j.status === 'lagging' || j.status === 'failed_recent'),
  );
  // Fresh install: missing critical jobs alone → ok for /health/ops (warn on dashboard)
  const ok = !criticalBad && coverage.status !== 'stale';

  return {
    ok,
    checkedAt: now.toISOString(),
    jobs,
    recentFailures,
    trackingCoverage: coverage,
    alerts,
  };
}
