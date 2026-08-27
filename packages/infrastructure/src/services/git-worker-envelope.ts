/** @file The git-worker's response-envelope contract and its transport-level decoding. */

/**
 * A NON-domain failure of the transport itself: a non-200 HTTP response (401 bad/missing secret,
 * 400 malformed body, 413 oversize, 500 unexpected worker error), a network/timeout error, or a
 * response body that does not parse as the expected `{ok, ...}` envelope. Distinct from a domain
 * refusal — which the worker reports as a 200 response with `{ok:false, error}` and which this
 * client instead RETURNS (never throws) as a `GitWorkerResult`. A caller can therefore tell the two
 * apart by whether the call threw at all: catch this type for a transport problem, otherwise read
 * `.ok` on the resolved `GitWorkerResult` for the worker's own (or absence of) a domain refusal.
 *
 * The message never includes the configured secret.
 */
export class GitWorkerTransportError extends Error {
  /** @param options - Standard `Error` cause-chaining options. */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GitWorkerTransportError';
  }
}

/**
 * The worker's own response envelope, reflected as-is: a domain success carries `data`; a domain
 * refusal carries the domain error's stable `name` (plus `path` for a `LiveContentFlushFailedError`).
 * This is NOT thrown — a domain refusal is a normal outcome the caller inspects via `.ok`. Contrast
 * with {@link GitWorkerTransportError}, which IS thrown, for a transport-level failure.
 */
export type GitWorkerResult<T> = { ok: true; data: T } | { ok: false; error: string; path?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parses a worker response body as the `{ok, ...}` envelope. Throws {@link GitWorkerTransportError}
 * when the body does not match the expected shape — that is a transport-level problem (the worker
 * is supposed to only ever return this shape on a 200), not a domain refusal.
 *
 * @param body - The parsed JSON response body.
 * @returns The typed envelope.
 */
export function parseEnvelope<T>(body: unknown): GitWorkerResult<T> {
  if (!isRecord(body) || typeof body.ok !== 'boolean') {
    throw new GitWorkerTransportError('git-worker response was not a recognised envelope');
  }
  if (body.ok) {
    // `T` is the caller-declared success payload shape for this specific RPC; there is no runtime
    // schema to validate an arbitrary `T` against here, and the worker/client share this envelope
    // contract by construction. Same unavoidable-cast shape as the carve-outs already granted
    // elsewhere in eslint.config.js (e.g. wasi-bridge.ts, pdf-preview-link-service.ts).
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- see comment above
    return { ok: true, data: body.data as T };
  }
  if (typeof body.error !== 'string') {
    throw new GitWorkerTransportError('git-worker response was not a recognised envelope');
  }
  const result: GitWorkerResult<T> = { ok: false, error: body.error };
  if (typeof body.path === 'string') return { ...result, path: body.path };
  return result;
}
