import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildOpsHealth,
  evaluateJobHealth,
  evaluateTrackingCoverage,
  lagThresholdMs,
  type WatchedJob,
} from './ops-health.js';

const job: WatchedJob = {
  name: 'trackingmore.poll',
  intervalMs: 15 * 60 * 1000,
  critical: true,
};

describe('ops-health', () => {
  it('lag threshold is 2× interval', () => {
    assert.equal(lagThresholdMs(15 * 60 * 1000), 30 * 60 * 1000);
  });

  it('marks ok when success is fresh', () => {
    const now = new Date('2026-07-27T12:00:00Z');
    const h = evaluateJobHealth(job, {
      lastSuccessAt: new Date('2026-07-27T11:50:00Z'),
      lastFinishedAt: new Date('2026-07-27T11:50:00Z'),
      lastStatus: 'success',
      now,
    });
    assert.equal(h.status, 'ok');
  });

  it('marks lagging beyond 2× interval', () => {
    const now = new Date('2026-07-27T12:00:00Z');
    const h = evaluateJobHealth(job, {
      lastSuccessAt: new Date('2026-07-27T11:00:00Z'),
      lastFinishedAt: new Date('2026-07-27T11:00:00Z'),
      lastStatus: 'success',
      now,
    });
    assert.equal(h.status, 'lagging');
  });

  it('marks missing when never succeeded', () => {
    const h = evaluateJobHealth(job, {
      lastSuccessAt: null,
      lastFinishedAt: null,
      lastStatus: null,
    });
    assert.equal(h.status, 'missing');
  });

  it('buildOpsHealth fails only on critical lag/fail', () => {
    const now = new Date();
    const lagging = evaluateJobHealth(job, {
      lastSuccessAt: new Date(now.getTime() - 60 * 60 * 1000),
      lastFinishedAt: new Date(now.getTime() - 60 * 60 * 1000),
      lastStatus: 'success',
      now,
    });
    const missingDaily = evaluateJobHealth(
      { name: 'reconcile.daily', intervalMs: 86400000, critical: false },
      { lastSuccessAt: null, lastFinishedAt: null, lastStatus: null, now },
    );
    assert.equal(buildOpsHealth([lagging], 0, now).ok, false);
    assert.equal(buildOpsHealth([missingDaily], 0, now).ok, true);
  });

  it('tracking coverage is ok with no stale rows', () => {
    const c = evaluateTrackingCoverage({ staleCount: 0, oldestUnpolledAt: null });
    assert.equal(c.status, 'ok');
  });

  it('tracking coverage is ok when stale rows are within threshold', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const c = evaluateTrackingCoverage({
      staleCount: 5,
      oldestUnpolledAt: new Date('2026-08-10T11:00:00Z'), // 1h gap < 2h threshold
      now,
    });
    assert.equal(c.status, 'ok');
  });

  it('tracking coverage goes stale beyond the threshold (poll-starvation regression guard)', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const c = evaluateTrackingCoverage({
      staleCount: 3,
      oldestUnpolledAt: new Date('2026-08-10T09:00:00Z'), // 3h gap > 2h threshold
      now,
    });
    assert.equal(c.status, 'stale');
    assert.equal(c.staleCount, 3);
  });

  it('buildOpsHealth fails when tracking coverage is stale even if all jobs report ok', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const okJob = evaluateJobHealth(job, {
      lastSuccessAt: new Date(now.getTime() - 5 * 60 * 1000),
      lastFinishedAt: new Date(now.getTime() - 5 * 60 * 1000),
      lastStatus: 'success',
      now,
    });
    const staleCoverage = evaluateTrackingCoverage({
      staleCount: 10,
      oldestUnpolledAt: new Date(now.getTime() - 3 * 3600 * 1000),
      now,
    });
    const health = buildOpsHealth([okJob], 0, now, staleCoverage);
    assert.equal(health.ok, false);
    assert.match(health.alerts.join('\n'), /trackingmore\.poll coverage/);
  });
});
