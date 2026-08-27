import { DomainError, LiveContentFlushFailedError, type Result } from '@asciidocollab/domain';

/**
 * Serializes a use case's `Result` onto the HTTP 200 envelope: a domain refusal is a NORMAL
 * outcome, not an HTTP error — only an unexpected throw (handled by the caller) becomes a 500. Uses
 * the error's stable `name` rather than its message, which may carry internals; the one documented
 * exception is `LiveContentFlushFailedError`, whose `path` field the caller needs to name the
 * offending file and is itself safe (a workspace-relative path, not a message).
 *
 * @param result - The use case's own `Result`.
 * @returns The wire envelope to serialize as the response body.
 */
export function toEnvelope(result: Result<unknown, DomainError>): Record<string, unknown> {
  if (result.success) return { ok: true, data: result.value };
  const envelope: Record<string, unknown> = { ok: false, error: result.error.name };
  if (result.error instanceof LiveContentFlushFailedError) {
    envelope.path = result.error.path;
  }
  return envelope;
}
