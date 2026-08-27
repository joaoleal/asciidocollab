import { DomainError } from '../domain-error';

/**
 * Raised when a commit is attempted with an empty or whitespace-only message. A commit must carry a
 * meaningful message, so this is a request-shape refusal the route boundary maps to a `422`.
 */
export class EmptyCommitMessageError extends DomainError {
  readonly name = 'EmptyCommitMessageError';

  /** Builds the refusal with the fixed message the caller is shown. */
  constructor() {
    super('A commit message is required');
  }
}
