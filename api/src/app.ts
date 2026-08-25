import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { Env } from './config.js';
import type { Db } from './db/pool.js';
import { collectOpsHealth } from './jobs/ops-health.js';
import { registerAdminAuthRoutes } from './routes/admin-auth.js';
import { registerAdminDashboardRoutes } from './routes/admin-dashboard.js';
import { registerAdminIngestionRunRoutes } from './routes/admin-ingestion-runs.js';
import { registerAdminMappingRoutes } from './routes/admin-mappings.js';
import { registerAdminPrivacyRoutes } from './routes/admin-privacy.js';
import { registerAdminReportRoutes } from './routes/admin-reports.js';
import { registerAdminShipmentRoutes } from './routes/admin-shipments.js';
import { registerExternalRoutes } from './routes/external.js';
import { registerOpsRoutes } from './routes/ops.js';
import { registerProductImageRoutes } from './routes/product-images.js';
import { registerPublicTrackingRoutes } from './routes/public-tracking.js';
import { registerRichPanelRoutes } from './routes/richpanel.js';

export type AppDeps = {
  db: Db;
  env: Env;
  /** When false, skip noisy logger in tests. Default true. */
  logger?: boolean;
};

/** Build Fastify app with all routes registered — does not listen or run bootstrap. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db, env } = deps;
  const app = Fastify({ logger: deps.logger ?? true });
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
  await registerOpsRoutes(app, { db, env });
  await registerExternalRoutes(app, { db, env });
  await registerAdminAuthRoutes(app, { db, env });
  await registerAdminDashboardRoutes(app, { db, env });
  await registerAdminIngestionRunRoutes(app, { db, env });
  await registerAdminPrivacyRoutes(app, { db, env });
  await registerAdminMappingRoutes(app, { db, env });
  await registerAdminReportRoutes(app, { db, env });
  await registerAdminShipmentRoutes(app, { db, env });

  return app;
}
