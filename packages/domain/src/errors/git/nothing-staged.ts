import { DomainError } from '../domain-error';

/**
 * Raised when a commit is attempted while nothing is staged. A commit records the staged index, so
 * with an empty index there is nothing to commit — a conflict-with-current-state refusal the route
 * boundary maps to a `409`.
 */
export class NothingStagedError extends DomainError {
  readonly name = 'NothingStagedError';

  /** Builds the refusal with the fixed message the caller is shown. */
  constructor() {
    super('There are no staged changes to commit');
  }
}
