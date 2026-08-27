import { DomainError } from '../domain-error';

/**
 * Raised when a conflict-resolution action (or a conflict read) is attempted for a project with
 * no operation currently `AWAITING_CONFLICT` — either nothing is conflicted, or the project's
 * active operation is in some other state. There is nothing to resolve or read without one.
 */
export class NoConflictInProgressError extends DomainError {
  readonly name = 'NoConflictInProgressError';

  /** Builds the refusal with the fixed message the caller is shown. */
  constructor() {
    super('This project has no conflict awaiting resolution');
  }
}
