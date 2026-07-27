/**
 * Create (or reset) an admin/staff user directly — no invite email.
 *
 *   npx tsx scripts/create-admin-user.ts <email> <password> [role]
 *
 * role defaults to "admin". If the email already exists, the password
 * and role are updated and the account is (re)activated.
 */
import { loadEnv } from '../api/src/config.js';
import { createPool } from '../api/src/db/pool.js';
import { hashPassword } from '../api/src/lib/crypto.js';
import { writeAudit } from '../api/src/lib/audit.js';

async function main(): Promise<void> {
  const [emailArg, password, roleArg] = process.argv.slice(2);
  const role = roleArg ?? 'admin';

  if (!emailArg || !password) {
    console.error('Usage: npx tsx scripts/create-admin-user.ts <email> <password> [admin|staff]');
    process.exit(1);
  }
  if (role !== 'admin' && role !== 'staff') {
    console.error(`Invalid role "${role}" — must be "admin" or "staff"`);
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters');
    process.exit(1);
  }

  const email = emailArg.trim().toLowerCase();
  const env = loadEnv();
  const db = createPool(env);

  const passwordHash = await hashPassword(password);
  const { rows } = await db.query<{ id: string; inserted: boolean }>(
    `INSERT INTO admin_users (email, password_hash, role, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role,
       status = 'active',
       failed_login_attempts = 0,
       locked_until = null,
       updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [email, passwordHash, role],
  );

  const user = rows[0];
  await writeAudit(db, {
    actorId: user.id,
    action: user.inserted ? 'admin.user.created_via_script' : 'admin.user.reset_via_script',
    targetType: 'admin_user',
    targetId: user.id,
    metadata: { email, role },
  });

  console.log(`${user.inserted ? 'Created' : 'Updated'} ${role} user: ${email} (id ${user.id})`);
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
