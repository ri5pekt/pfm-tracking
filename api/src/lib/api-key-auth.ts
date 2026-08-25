/**
 * Shared API-key auth for machine consumers (RichPanel, Ops, External, …).
 * Accepts `X-Api-Key: <key>` or `Authorization: Bearer <key>`.
 */
export function authorizeApiKey(
  request: { headers: Record<string, unknown> },
  expectedKey: string | null | undefined,
): boolean {
  if (!expectedKey) return false;
  const header = request.headers['x-api-key'] ?? request.headers.authorization;
  if (typeof header !== 'string') return false;
  const token = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : header.trim();
  return token === expectedKey;
}
