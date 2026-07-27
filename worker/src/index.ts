import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const QUEUE_NAME = 'pfm-jobs';
const TM_POLL_JOB = 'trackingmore.poll';
const SHIPBOB_SYNC_JOB = 'shipbob.sync';
const KLB_SYNC_JOB = 'klb.sync';
const STALLED_JOB = 'stalled.detect';
const RETENTION_JOB = 'retention.scrub';
const RECONCILE_JOB = 'reconcile.daily';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Production image layout: /app/worker/dist/index.js → repo root is /app
const DAY_MS = 24 * 60 * 60 * 1000;

function runScript(scriptRel: string): Promise<{ ok: boolean; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', scriptRel], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
      shell: true,
    });
    child.on('exit', (code) => resolve({ ok: code === 0, code }));
  });
}

async function main(): Promise<void> {
  const queue = new Queue(QUEUE_NAME, { connection });

  await queue.add(
    TM_POLL_JOB,
    { reason: 'schedule' },
    {
      repeat: { every: 15 * 60 * 1000 },
      removeOnComplete: 20,
      removeOnFail: 50,
      jobId: 'trackingmore-poll-repeat',
    },
  );

  await queue.add(
    SHIPBOB_SYNC_JOB,
    { reason: 'schedule' },
    {
      repeat: { every: 20 * 60 * 1000 },
      removeOnComplete: 20,
      removeOnFail: 50,
      jobId: 'shipbob-sync-repeat',
    },
  );

  await queue.add(
    KLB_SYNC_JOB,
    { reason: 'schedule' },
    {
      repeat: { every: 20 * 60 * 1000 },
      removeOnComplete: 20,
      removeOnFail: 50,
      jobId: 'klb-sync-repeat',
    },
  );

  for (const [name, jobId] of [
    [STALLED_JOB, 'stalled-detect-daily'],
    [RETENTION_JOB, 'retention-scrub-daily'],
    [RECONCILE_JOB, 'reconcile-daily'],
  ] as const) {
    await queue.add(
      name,
      { reason: 'schedule' },
      {
        repeat: { every: DAY_MS },
        removeOnComplete: 20,
        removeOnFail: 50,
        jobId,
      },
    );
  }

  await queue.add(TM_POLL_JOB, { reason: 'startup' }, { removeOnComplete: 20, removeOnFail: 50 });
  await queue.add(SHIPBOB_SYNC_JOB, { reason: 'startup' }, { removeOnComplete: 20, removeOnFail: 50 });
  await queue.add(KLB_SYNC_JOB, { reason: 'startup' }, { removeOnComplete: 20, removeOnFail: 50 });
  await queue.add(STALLED_JOB, { reason: 'startup' }, { removeOnComplete: 20, removeOnFail: 50 });
  await queue.add(RECONCILE_JOB, { reason: 'startup' }, { removeOnComplete: 20, removeOnFail: 50 });

  await queue.add(
    'worker.heartbeat',
    { at: new Date().toISOString() },
    { removeOnComplete: 20, removeOnFail: 50 },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === 'worker.heartbeat') {
        console.log(`[worker] heartbeat ${JSON.stringify(job.data)}`);
        return { ok: true };
      }
      const scripts: Record<string, string> = {
        [TM_POLL_JOB]: 'scripts/sync-trackingmore.ts',
        [SHIPBOB_SYNC_JOB]: 'scripts/sync-shipbob.ts',
        [KLB_SYNC_JOB]: 'scripts/sync-klb.ts',
        [STALLED_JOB]: 'scripts/sync-stalled.ts',
        [RETENTION_JOB]: 'scripts/sync-retention.ts',
        [RECONCILE_JOB]: 'scripts/sync-reconcile.ts',
      };
      const script = scripts[job.name];
      if (script) {
        console.log(`[worker] ${job.name} (${job.data?.reason ?? 'manual'})`);
        return runScript(script);
      }
      console.log(`[worker] unhandled job ${job.name}`);
      return { ok: true };
    },
    { connection },
  );

  worker.on('failed', (job, err) => {
    console.error(`[worker] job failed ${job?.name}:`, err);
  });

  console.log(
    '[worker] listening; shipbob/klb 20m; tm 15m; stalled/retention/reconcile daily',
  );

  const shutdown = async () => {
    await worker.close();
    await queue.close();
    await connection.quit();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
