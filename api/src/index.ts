import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { loadEnv } from './config.js';
import { createPool } from './db/pool.js';
import { ensureBootstrapAdmin } from './bootstrap.js';
import { registerAdminAuthRoutes } from './routes/admin-auth.js';
import { getSession } from './lib/session.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createPool(env);

  const app = Fastify({ logger: true });
  await app.register(cookie);
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/admin/version', async () => ({
    version: env.APP_VERSION,
    gitSha: env.GIT_SHA,
    deployedAt: process.env.DEPLOYED_AT ?? null,
  }));

  app.get('/admin/shipments', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    // Empty list stub for Phase 0 shell
    return {
      items: [],
      counts: {
        all: 0,
        exception: 0,
        stalled: 0,
        out_for_delivery: 0,
        in_transit: 0,
        delivered: 0,
        cancelled: 0,
      },
    };
  });

  await registerAdminAuthRoutes(app, { db, env });
  await ensureBootstrapAdmin(db, env);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
