import type { FastifyReply } from 'fastify';

/**
 * Shared response envelope a git route sends for a domain refusal: the repo-standard
 * `{ error: { code, message } }` shape (matches `file-tree-errors.ts`), plus an optional
 * `error.details.path` naming the file a `LiveContentFlushFailedError` could not read.
 */
export interface GitErrorResponseBody {
  error: { code: string; message: string; details?: { path?: string } };
}

/** The HTTP status and response body a git route should send for a mapped domain refusal. */
export interface GitErrorResponse {
  status: number;
  body: GitErrorResponseBody;
}

/** One row of the domain-error-name -> wire-response table (all but `LiveContentFlushFailedError`, handled separately below since it also carries a path). */
interface GitErrorTableEntry {
  status: number;
  code: string;
  message: string;
}

const GIT_ERROR_TABLE: Readonly<Record<string, GitErrorTableEntry>> = {
  InsufficientRoleError: {
    status: 403,
    code: 'insufficient_role',
    message: 'You do not have the required role for this action',
  },
  RepositoryNotConnectedError: {
    status: 404,
    code: 'repository_not_connected',
    message: 'This project has no connected Git repository',
  },
  RepositoryAlreadyConnectedError: {
    status: 409,
    code: 'already_connected',
    message: 'This project is already connected to a Git repository',
  },
  GitOperationInProgressError: {
    status: 409,
    code: 'git_operation_in_progress',
    message: 'A git operation is already in progress for this project',
  },
  NothingStagedError: {
    status: 409,
    code: 'nothing_staged',
    message: 'There are no staged changes to commit',
  },
  EmptyCommitMessageError: {
    status: 422,
    code: 'empty_commit_message',
    message: 'A commit message is required',
  },
  ValidationError: {
    status: 400,
    code: 'validation_error',
    message: 'The request was invalid',
  },
  GitCommandFailedError: {
    status: 500,
    code: 'git_command_failed',
    message: 'The git command failed to complete',
  },
  UnresolvedConflictsError: {
    status: 409,
    code: 'unresolved_conflicts',
    message: 'This operation still has unresolved conflicts',
  },
  NothingToUndoError: {
    status: 409,
    code: 'nothing_to_undo',
    message: 'There is nothing to undo for this project',
  },
  GitConflictNotFoundError: {
    status: 422,
    code: 'validation_error',
    message: 'No conflict recorded for that path',
  },
  NoConflictInProgressError: {
    status: 404,
    code: 'no_conflict_in_progress',
    message: 'This project has no conflict awaiting resolution',
  },
  InvalidResolutionError: {
    status: 422,
    code: 'validation_error',
    message: 'The submitted resolution is invalid for this conflict',
  },
  RepositoryUnreachableError: {
    status: 422,
    code: 'repository_unreachable',
    message: 'The remote repository could not be reached',
  },
  AuthenticationFailedError: {
    status: 401,
    code: 'authentication_failed',
    message: 'Authentication with the remote repository failed',
  },
};

/**
 * Maps a git-domain error's stable NAME string — as returned in a `GitWorkerResult`'s `error`
 * field, or thrown by a domain git use case — to the HTTP status and `{ error: { code, message } }`
 * envelope a route should send. This is the ONE table every git read and write route consults, so
 * every git error looks the same on the wire regardless of which route or worker call produced it.
 *
 * Not used for a thrown `GitWorkerTransportError` — that is a transport failure, not a domain
 * refusal, and the route that catches it replies `502` directly (never echoing the transport
 * error's message, which may name a worker endpoint or status code but never the shared secret).
 *
 * @param errorName - The domain error's stable `name` (e.g. `'RepositoryNotConnectedError'`).
 * @param path - For `LiveContentFlushFailedError`, the file whose live content could not be read.
 * @returns The status and body to send. An unrecognised name maps to a generic `500 internal_error`
 *   — never assume every possible error name is in the table.
 */
export function gitErrorResponse(errorName: string, path?: string): GitErrorResponse {
  if (errorName === 'LiveContentFlushFailedError') {
    const message = path
      ? `Could not read the current collaborative content for "${path}"; the commit was aborted, so no changes were written`
      : 'Could not read the current collaborative content for a staged file; the commit was aborted, so no changes were written';
    return {
      status: 409,
      body: {
        error: {
          code: 'live_content_flush_failed',
          message,
          ...(path ? { details: { path } } : {}),
        },
      },
    };
  }

  const entry = GIT_ERROR_TABLE[errorName];
  if (entry) {
    return { status: entry.status, body: { error: { code: entry.code, message: entry.message } } };
  }

  return { status: 500, body: { error: { code: 'internal_error', message: 'An unexpected error occurred' } } };
}

/** Sends {@link gitErrorResponse}'s mapped status/body for the given domain error name (+ optional path). */
export function sendGitErrorResponse(reply: FastifyReply, errorName: string, path?: string) {
  const { status, body } = gitErrorResponse(errorName, path);
  return reply.status(status).send(body);
}

/**
 * Sends the standard `502` response for a git-worker transport failure — the worker was
 * unreachable, timed out, or returned a response the client could not parse. Every git route that
 * calls the worker catches a thrown `GitWorkerTransportError` and replies with this, never echoing
 * the transport error's own message (which can name an internal endpoint path or HTTP status, but
 * must never reach the client, and never the shared secret).
 */
export function sendGitWorkerUnavailableResponse(reply: FastifyReply) {
  return reply.status(502).send({
    error: { code: 'git_worker_unavailable', message: 'The git service is temporarily unavailable' },
  });
}
