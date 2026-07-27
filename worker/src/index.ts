import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const QUEUE_NAME = 'pfm-jobs';

async function main(): Promise<void> {
  // Phase 0: worker process boots and registers empty job handlers.
  // Phase 1 adds shipbob.orders.sync + shipbob.tracking.poll.
  const queue = new Queue(QUEUE_NAME, { connection });
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
      console.log(`[worker] unhandled job ${job.name}`);
      return { ok: true };
    },
    { connection },
  );

  worker.on('failed', (job, err) => {
    console.error(`[worker] job failed ${job?.name}:`, err);
  });

  console.log('[worker] listening on queue', QUEUE_NAME);

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
