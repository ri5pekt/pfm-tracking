/**
 * Wrapped HTTP client: redacts Authorization (and similar) headers before logging.
 * Full request/response body capture is Phase 1; Phase 0 ships the redact + timing stub.
 */

const REDACT_HEADER_KEYS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
]);

export type HttpLogEntry = {
  integration: string;
  operation: string;
  method: string;
  url: string;
  status?: number;
  durationMs: number;
  errorMessage?: string;
  requestHeadersRedacted: Record<string, string>;
};

export function redactHeaders(
  headers: Headers | Record<string, string> | Array<[string, string]> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;

  const entries =
    typeof Headers !== 'undefined' && headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);

  for (const [key, value] of entries) {
    out[key] = REDACT_HEADER_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : String(value);
  }
  return out;
}

export type LoggedFetchOptions = RequestInit & {
  integration: string;
  operation: string;
  onLog?: (entry: HttpLogEntry) => void | Promise<void>;
};

export async function loggedFetch(url: string, options: LoggedFetchOptions): Promise<Response> {
  const { integration, operation, onLog, ...init } = options;
  const started = Date.now();
  const requestHeadersRedacted = redactHeaders(init.headers as Record<string, string> | undefined);

  try {
    const response = await fetch(url, init);
    const entry: HttpLogEntry = {
      integration,
      operation,
      method: (init.method ?? 'GET').toUpperCase(),
      url: redactUrl(url),
      status: response.status,
      durationMs: Date.now() - started,
      requestHeadersRedacted,
    };
    await onLog?.(entry);
    return response;
  } catch (err) {
    const entry: HttpLogEntry = {
      integration,
      operation,
      method: (init.method ?? 'GET').toUpperCase(),
      url: redactUrl(url),
      durationMs: Date.now() - started,
      errorMessage: err instanceof Error ? err.message : String(err),
      requestHeadersRedacted,
    };
    await onLog?.(entry);
    throw err;
  }
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/key|token|secret|password|auth/i.test(key)) {
        u.searchParams.set(key, '[REDACTED]');
      }
    }
    return u.toString();
  } catch {
    return url;
  }
}
