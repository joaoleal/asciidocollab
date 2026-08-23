import { DomainError } from '../domain-error';

/**
 * Raised when a user asks for a clone while one of their own clones is still
 * running. Cloning copies a whole project, so one in flight per user bounds the
 * concurrent cost; the running clone is unaffected. Maps to HTTP 409.
 */
export class CloneAlreadyInProgressError extends DomainError {
  readonly name = 'CloneAlreadyInProgressError';

  /** Builds the refusal with the fixed message the caller is shown. */
  constructor() {
    super('A clone is already running for this user');
  }
}
