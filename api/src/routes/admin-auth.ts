import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Env } from '../config.js';
import type { Db } from '../db/pool.js';
import { writeAudit } from '../lib/audit.js';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../lib/crypto.js';
import { clearSession, getSession, setSession, type SessionUser } from '../lib/session.js';

type AuthDeps = { db: Db; env: Env };

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const inviteBody = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'staff']).default('staff'),
});

const acceptInviteBody = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export async function registerAdminAuthRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { db, env } = deps;

  app.post('/admin/auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const email = parsed.data.email.toLowerCase();
    const { rows } = await db.query<{
      id: string;
      email: string;
      role: 'admin' | 'staff';
      status: string;
      password_hash: string | null;
      failed_login_attempts: number;
      locked_until: Date | null;
    }>(
      `SELECT id, email, role, status, password_hash, failed_login_attempts, locked_until
       FROM admin_users WHERE email = $1`,
      [email],
    );

    const user = rows[0];
    if (!user || !user.password_hash || user.status !== 'active') {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      return reply.code(423).send({ error: 'account_locked' });
    }

    const ok = await verifyPassword(parsed.data.password, user.password_hash);
    if (!ok) {
      const attempts = user.failed_login_attempts + 1;
      const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await db.query(
        `UPDATE admin_users
         SET failed_login_attempts = $2, locked_until = $3, updated_at = now()
         WHERE id = $1`,
        [user.id, attempts, lockedUntil],
      );
      await writeAudit(db, {
        actorId: null,
        action: 'admin.login_failed',
        targetType: 'admin_user',
        targetId: user.id,
        metadata: { email },
      });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    await db.query(
      `UPDATE admin_users
       SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
       WHERE id = $1`,
      [user.id],
    );

    const session: SessionUser = { id: user.id, email: user.email, role: user.role };
    setSession(reply, session, env.ADMIN_SESSION_SECRET);
    await writeAudit(db, {
      actorId: user.id,
      action: 'admin.login',
      targetType: 'admin_user',
      targetId: user.id,
    });
    return { user: session };
  });

  app.post('/admin/auth/logout', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    clearSession(reply);
    if (user) {
      await writeAudit(db, {
        actorId: user.id,
        action: 'admin.logout',
        targetType: 'admin_user',
        targetId: user.id,
      });
    }
    return { ok: true };
  });

  app.get('/admin/auth/me', async (request, reply) => {
    const user = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    return { user };
  });

  app.post('/admin/invites', async (request, reply) => {
    const actor = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (actor.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });

    const parsed = inviteBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const email = parsed.data.email.toLowerCase();
    const existing = await db.query(`SELECT id FROM admin_users WHERE email = $1`, [email]);
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'user_exists' });
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO admin_invites (email, role, purpose, token_hash, invited_by, expires_at)
       VALUES ($1, $2, 'invite', $3, $4, $5)
       RETURNING id`,
      [email, parsed.data.role, tokenHash, actor.id, expiresAt],
    );

    await writeAudit(db, {
      actorId: actor.id,
      action: 'admin.invite_created',
      targetType: 'admin_invite',
      targetId: rows[0].id,
      metadata: { email, role: parsed.data.role },
    });

    // Token returned once for Phase 0 (email delivery comes later).
    return {
      inviteId: rows[0].id,
      email,
      role: parsed.data.role,
      expiresAt: expiresAt.toISOString(),
      acceptToken: token,
      acceptUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/#/accept-invite?token=${encodeURIComponent(token)}`,
    };
  });

  app.post('/admin/invites/accept', async (request, reply) => {
    const parsed = acceptInviteBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const tokenHash = hashToken(parsed.data.token);
    const { rows } = await db.query<{
      id: string;
      email: string;
      role: 'admin' | 'staff';
      expires_at: Date;
      used_at: Date | null;
    }>(
      `SELECT id, email, role, expires_at, used_at
       FROM admin_invites
       WHERE token_hash = $1 AND purpose = 'invite'`,
      [tokenHash],
    );

    const invite = rows[0];
    if (!invite || invite.used_at || invite.expires_at.getTime() < Date.now()) {
      return reply.code(400).send({ error: 'invalid_or_expired_invite' });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO admin_users (email, password_hash, role, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [invite.email, passwordHash, invite.role],
      );
      if (inserted.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'user_exists' });
      }
      await client.query(`UPDATE admin_invites SET used_at = now() WHERE id = $1`, [invite.id]);
      await client.query('COMMIT');

      const session: SessionUser = {
        id: inserted.rows[0].id,
        email: invite.email,
        role: invite.role,
      };
      setSession(reply, session, env.ADMIN_SESSION_SECRET);
      await writeAudit(db, {
        actorId: session.id,
        action: 'admin.invite_accepted',
        targetType: 'admin_user',
        targetId: session.id,
        metadata: { inviteId: invite.id },
      });
      return { user: session };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.get('/admin/users', async (request, reply) => {
    const actor = getSession(request, env.ADMIN_SESSION_SECRET);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (actor.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });

    const { rows } = await db.query(
      `SELECT id, email, role, status, last_login_at, created_at
       FROM admin_users
       ORDER BY created_at ASC`,
    );
    return { users: rows };
  });
}
