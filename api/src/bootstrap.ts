import type { Db } from './db/pool.js';
import type { Env } from './config.js';
import { hashPassword } from './lib/crypto.js';
import { writeAudit } from './lib/audit.js';

/** Create the first admin from env if the users table is empty. */
export async function ensureBootstrapAdmin(db: Db, env: Env): Promise<void> {
  const { rows } = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM admin_users`);
  if (Number(rows[0]?.count ?? 0) > 0) return;

  if (!env.ADMIN_BOOTSTRAP_EMAIL || !env.ADMIN_BOOTSTRAP_PASSWORD) {
    console.warn(
      'No admin users and ADMIN_BOOTSTRAP_EMAIL/PASSWORD not set — create an admin manually after migrate.',
    );
    return;
  }

  const passwordHash = await hashPassword(env.ADMIN_BOOTSTRAP_PASSWORD);
  const email = env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase();
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, role, status)
     VALUES ($1, $2, 'admin', 'active')
     RETURNING id`,
    [email, passwordHash],
  );

  await writeAudit(db, {
    actorId: inserted.rows[0].id,
    action: 'admin.bootstrap',
    targetType: 'admin_user',
    targetId: inserted.rows[0].id,
    metadata: { email },
  });

  console.log(`Bootstrap admin created: ${email}`);
}
