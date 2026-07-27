import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildOpsHealth,
  evaluateJobHealth,
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
});
