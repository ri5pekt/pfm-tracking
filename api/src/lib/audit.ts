import type { Db } from '../db/pool.js';

export async function writeAudit(
  db: Db,
  input: {
    actorId: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.actorId,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
}
