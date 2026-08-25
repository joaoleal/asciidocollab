import { DomainError } from '../domain-error';

/** Reason a collaboration connection was denied — surfaced at the boundary for audit logging. */
export type CollabConnectionDenialReason =
  | 'document_not_found'
  | 'cross_project'
  | 'not_a_member'
  | 'git_operation_in_progress';

/**
 * Raised when a user may not open a collaboration connection to a document: the document does not
 * exist, it belongs to a different project than the one claimed in the room name, the user is not
 * a member of the project, or a content-changing git operation (import/pull/checkout) is currently
 * replacing the project's working tree. The `reason` lets the delivery layer log a precise audit
 * reason, and — for `git_operation_in_progress` — map to the same `409` signal as the file-tree
 * write-lock, rather than a `403`.
 */
export class CollabConnectionDeniedError extends DomainError {
  readonly name = 'CollabConnectionDeniedError';

  /**
   * @param reason - The machine-readable denial reason for audit logging.
   */
  constructor(public readonly reason: CollabConnectionDenialReason) {
    super(`Collaboration connection denied: ${reason}`);
  }
}
