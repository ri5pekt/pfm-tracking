import type { Db } from '../db/pool.js';

export type IngestionRunItemAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'skipped'
  | 'error';

export type IngestionRunItemInput = {
  orderNumber?: string | null;
  orderId?: string | null;
  shipmentId?: string | null;
  trackingNumber?: string | null;
  externalId?: string | null;
  action: IngestionRunItemAction;
  detail?: string | null;
};

export async function startIngestionRun(
  db: Db,
  jobName: string,
  cursorBefore: Date | null = null,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ingestion_runs (job_name, cursor_before) VALUES ($1, $2) RETURNING id`,
    [jobName, cursorBefore],
  );
  return rows[0]!.id;
}

export async function finishIngestionRun(
  db: Db,
  id: string,
  input: {
    status: 'success' | 'partial' | 'failed';
    recordsSeen?: number;
    recordsUpserted?: number;
    eventsAppended?: number;
    cursorAfter?: Date | null;
    errors?: unknown;
  },
): Promise<void> {
  await db.query(
    `UPDATE ingestion_runs SET
       finished_at = now(),
       status = $2,
       records_seen = $3,
       records_upserted = $4,
       events_appended = $5,
       cursor_after = $6,
       errors = $7
     WHERE id = $1`,
    [
      id,
      input.status,
      input.recordsSeen ?? 0,
      input.recordsUpserted ?? 0,
      input.eventsAppended ?? 0,
      input.cursorAfter ?? new Date(),
      input.errors ? JSON.stringify(input.errors) : null,
    ],
  );
}

export async function touchSyncCursor(
  db: Db,
  jobName: string,
  cursorAt: Date = new Date(),
): Promise<void> {
  await db.query(
    `INSERT INTO sync_cursors (job_name, cursor_at, last_success_at, updated_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (job_name) DO UPDATE SET
       cursor_at = EXCLUDED.cursor_at,
       last_success_at = now(),
       updated_at = now()`,
    [jobName, cursorAt],
  );
}

/** Batch-insert run detail lines (chunks of 200). */
export async function appendRunItems(
  db: Db,
  runId: string,
  items: IngestionRunItemInput[],
): Promise<number> {
  if (!items.length) return 0;
  const chunkSize = 200;
  let inserted = 0;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let p = 1;
    for (const item of chunk) {
      placeholders.push(
        `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`,
      );
      values.push(
        runId,
        item.orderNumber ?? null,
        item.orderId ?? null,
        item.shipmentId ?? null,
        item.trackingNumber ?? null,
        item.externalId ?? null,
        item.action,
        item.detail ?? null,
      );
    }
    const result = await db.query(
      `INSERT INTO ingestion_run_items (
         run_id, order_number, order_id, shipment_id, tracking_number, external_id, action, detail
       ) VALUES ${placeholders.join(',')}`,
      values,
    );
    inserted += result.rowCount ?? chunk.length;
  }
  return inserted;
}

export function deriveIngestionSource(
  jobName: string,
): 'shipbob' | 'klb' | 'trackingmore' | 'system' {
  if (jobName.startsWith('shipbob.')) return 'shipbob';
  if (jobName.startsWith('klb.')) return 'klb';
  if (jobName.startsWith('trackingmore.')) return 'trackingmore';
  return 'system';
}
