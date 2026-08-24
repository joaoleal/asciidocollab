import { DomainError } from '../domain-error';

/**
 * Raised by the single-flight guard when a mutating git action is requested
 * for a project that already has an active operation (queued, running, or
 * awaiting conflict resolution). The in-flight operation is unaffected; the
 * caller should retry once it completes. Maps to the `git_operation_in_progress`
 * wire error code.
 */
export class GitOperationInProgressError extends DomainError {
  readonly name = 'GitOperationInProgressError';

  /** Builds the refusal with the fixed message the caller is shown. */
  constructor() {
    super('A git operation is already in progress for this project');
  }
}
