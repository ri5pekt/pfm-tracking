import type { Db } from '../db/pool.js';
import { loggedFetch, type HttpLogEntry } from '../lib/http-client.js';

export async function logApiCall(db: Db | null, entry: HttpLogEntry): Promise<void> {
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO api_call_log (
         integration, operation, http_method, url, response_status, duration_ms, error_message
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        entry.integration,
        entry.operation,
        entry.method,
        entry.url,
        entry.status ?? null,
        entry.durationMs,
        entry.errorMessage ?? null,
      ],
    );
  } catch {
    // never fail callers on logging
  }
}

export function makeOnLog(db: Db | null) {
  return (entry: HttpLogEntry) => logApiCall(db, entry);
}

export { loggedFetch };
