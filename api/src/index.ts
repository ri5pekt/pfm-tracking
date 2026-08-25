import { loadEnv } from './config.js';
import { createPool } from './db/pool.js';
import { ensureBootstrapAdmin } from './bootstrap.js';
import { ensureOrderTokensSealed } from './domain/public-tracking.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createPool(env);

  const app = await buildApp({ db, env });
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
