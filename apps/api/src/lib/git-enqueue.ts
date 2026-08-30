import type { FastifyRequest } from 'fastify';
import {
  GitOperationInProgressError,
  type EnqueueGitOperationInput,
  type GitOperation,
  type Result,
} from '@asciidocollab/domain';

/**
 * Enqueues a `GitOperation` on behalf of an asynchronous git route, turning the one refusal
 * `enqueue` signals by THROWING into the same typed `Result` these routes already handle for their
 * role gate — so the caller answers it through `sendGitErrorResponse`, the single git-error table,
 * exactly as every synchronous git route does.
 *
 * A project may only have one active operation at a time: the `GitOperation_one_active_per_project`
 * partial-unique index enforces that in the database, and the repository adapter converts the
 * resulting P2002 into a thrown `GitOperationInProgressError`. Nothing in the HTTP layer used to
 * catch it, so it reached the global error handler — which only honours an `error.statusCode` a
 * `DomainError` does not carry. A second pull queued behind a first therefore answered
 * `500 INTERNAL_ERROR` instead of the `409 git_operation_in_progress` its synchronous siblings
 * answer for the identical refusal, and the web client had no `409` to react to.
 *
 * Every other error is rethrown untouched: a genuine storage failure is still a 500.
 *
 * @param request - The current Fastify request (source of the git-operation repository).
 * @param input - The operation to enqueue.
 * @returns `{ success: true, value: operation }` on success, or `{ success: false, error }` carrying
 *   a `GitOperationInProgressError` when the project already has an active operation.
 */
export async function enqueueGitOperation(
  request: FastifyRequest,
  input: EnqueueGitOperationInput,
): Promise<Result<GitOperation, GitOperationInProgressError>> {
  try {
    const operation = await request.server.repos.gitOperation.enqueue(input);
    return { success: true, value: operation };
  } catch (error) {
    if (error instanceof GitOperationInProgressError) {
      return { success: false, error };
    }
    throw error;
  }
}
