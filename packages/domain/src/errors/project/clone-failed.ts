import { DomainError } from '../domain-error';

/**
 * Raised when a clone failed for any reason other than the specific cases that
 * have their own error. Compensating cleanup has already run by the time this is
 * returned, so nothing the clone built survives. Maps to HTTP 500.
 *
 * The underlying failure is carried as `cause` for logging only — it may name
 * storage paths or driver internals, so it is deliberately kept out of the
 * message the caller is shown.
 */
export class CloneFailedError extends DomainError {
  readonly name = 'CloneFailedError';

  /**
   * @param cause - The underlying failure that aborted the clone.
   */
  constructor(cause: unknown) {
    super('The clone could not be completed', { cause });
  }
}
