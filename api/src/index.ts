import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { loadEnv } from './config.js';
import { createPool } from './db/pool.js';
import { ensureBootstrapAdmin } from './bootstrap.js';
import { ensureOrderTokensSealed } from './domain/public-tracking.js';
import { collectOpsHealth } from './jobs/ops-health.js';
import { registerAdminAuthRoutes } from './routes/admin-auth.js';
import { registerAdminDashboardRoutes } from './routes/admin-dashboard.js';
import { registerAdminIngestionRunRoutes } from './routes/admin-ingestion-runs.js';
import { registerAdminMappingRoutes } from './routes/admin-mappings.js';
import { registerAdminPrivacyRoutes } from './routes/admin-privacy.js';
import { registerAdminReportRoutes } from './routes/admin-reports.js';
import { registerAdminShipmentRoutes } from './routes/admin-shipments.js';
import { registerProductImageRoutes } from './routes/product-images.js';
import { registerPublicTrackingRoutes } from './routes/public-tracking.js';
import { registerRichPanelRoutes } from './routes/richpanel.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createPool(env);

  const app = Fastify({ logger: true });
  await app.register(cookie);
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  /** Liveness — process up (external uptime ping). */
  app.get('/health', async () => ({ ok: true }));

  /** Readiness — Postgres reachable. */
  app.get('/health/ready', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      return { ok: true };
    } catch (err) {
      reply.code(503);
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  /**
   * Ops probe — 503 when a critical sync job lags > 2× schedule (or failed recently).
   * Point UptimeRobot / Better Stack at this URL after cutover.
   */
  app.get('/health/ops', async (_request, reply) => {
    try {
      const health = await collectOpsHealth(db);
      if (!health.ok) reply.code(503);
      return health;
    } catch (err) {
      reply.code(503);
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.get('/admin/version', async () => ({
    version: env.APP_VERSION,
    gitSha: env.GIT_SHA,
    deployedAt: process.env.DEPLOYED_AT ?? null,
  }));

  await registerProductImageRoutes(app);
  await registerPublicTrackingRoutes(app, { db, env });
  await registerRichPanelRoutes(app, { db, env });
  await registerAdminAuthRoutes(app, { db, env });
  await registerAdminDashboardRoutes(app, { db, env });
  await registerAdminIngestionRunRoutes(app, { db, env });
  await registerAdminPrivacyRoutes(app, { db, env });
  await registerAdminMappingRoutes(app, { db, env });
  await registerAdminReportRoutes(app, { db, env });
  await registerAdminShipmentRoutes(app, { db, env });
  await ensureBootstrapAdmin(db, env);

  const sealed = await ensureOrderTokensSealed(db, env.ADMIN_SESSION_SECRET);
  if (sealed > 0) {
    app.log.info({ sealed }, 'minted public tracking tokens for existing orders');
  }

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
