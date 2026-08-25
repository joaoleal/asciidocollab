import type { GitOperation, GitOperationKind } from '@asciidocollab/domain';

/**
 * How a dispatched `GitOperation` finished. `succeeded`/`failed`/`aborted` are terminal — the run
 * loop transitions the operation to the matching state and records an `AuditLog` entry.
 * `awaitingConflict` is not terminal: the run loop moves the operation to `AWAITING_CONFLICT` and
 * stops without auditing (the conflict-resolution use case that eventually resumes it is a story
 * task's concern, not this one's).
 */
export type GitOperationOutcome =
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'failed'; readonly errorCode: string }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'awaitingConflict' };

/**
 * Runs the use case for one claimed `GitOperation`, returning how it finished. May throw — the
 * run loop (via {@link dispatchGitOperation}) treats any throw as a generic, safe failure rather
 * than ever surfacing the raw error into the terminal state or the `AuditLog`.
 */
export type GitOperationHandler = (operation: GitOperation) => Promise<GitOperationOutcome>;

/**
 * Maps each `GitOperationKind` to the handler that implements it. A kind with no entry dispatches
 * as an unimplemented-kind failure (see {@link dispatchGitOperation}) — this is the seam the
 * composition root wires each git use case into as its story task builds it; none are wired yet
 * (YAGNI — use-case bodies are not this task's job).
 */
export type GitOperationHandlerRegistry = Partial<Record<GitOperationKind, GitOperationHandler>>;

/** Safe, typed error code recorded when a claimed operation's kind has no registered handler. */
export const UNHANDLED_GIT_OPERATION_KIND_ERROR_CODE = 'UNHANDLED_GIT_OPERATION_KIND';

/**
 * Safe, typed error code recorded when a registered handler throws rather than returning an
 * outcome — the handler's own error is never itself recorded (it could carry unsafe internals).
 */
export const GIT_OPERATION_HANDLER_FAILED_ERROR_CODE = 'GIT_OPERATION_HANDLER_FAILED';

/**
 * Safe, typed error code recorded when the run loop's per-job clean-start step
 * (`ensureCleanWorkingTree`) throws, before a handler ever runs. Failing the job immediately
 * with this code — rather than leaving it stuck `RUNNING` for the stale-heartbeat sweep to
 * eventually reclaim — keeps a working tree that can't be cleaned from becoming a silent,
 * repeatedly-retried poison item on the work-list.
 */
export const ENSURE_CLEAN_WORKING_TREE_FAILED_ERROR_CODE = 'ENSURE_CLEAN_WORKING_TREE_FAILED';

/**
 * Dispatches a claimed operation to the handler registered for its `kind` in `registry`.
 * Normalizes both "no handler registered for this kind" and "the registered handler threw" into a
 * safe `failed` outcome, so the run loop never needs its own try/catch around a handler call and
 * an unexpected throw can never carry unsafe internals into the terminal state or `AuditLog`.
 *
 * @param operation - The claimed operation to dispatch.
 * @param registry - The kind → handler mapping to dispatch through.
 * @returns The outcome the run loop should act on.
 */
export async function dispatchGitOperation(
  operation: GitOperation,
  registry: GitOperationHandlerRegistry,
): Promise<GitOperationOutcome> {
  const handler = registry[operation.kind];
  if (!handler) {
    return { kind: 'failed', errorCode: UNHANDLED_GIT_OPERATION_KIND_ERROR_CODE };
  }

  try {
    return await handler(operation);
  } catch {
    return { kind: 'failed', errorCode: GIT_OPERATION_HANDLER_FAILED_ERROR_CODE };
  }
}
