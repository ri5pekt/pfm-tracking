import { createHash } from 'node:crypto';

/** Dedupe key per docs/dev-plan.md §5.4 */
export function buildEventHash(input: {
  shipmentId: string;
  occurredAt: Date;
  rawStatus: string;
  rawSubstatusCode: string | null | undefined;
  description: string | null | undefined;
}): string {
  const occurredIso = input.occurredAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const parts = [
    input.shipmentId,
    occurredIso,
    input.rawStatus ?? '',
    input.rawSubstatusCode ?? '',
    input.description ?? '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
