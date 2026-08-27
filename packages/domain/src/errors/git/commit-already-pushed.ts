import { DomainError } from '../domain-error';

/**
 * Raised when an amend is attempted on a commit that has already been pushed to the remote. Amending
 * rewrites the most-recent commit, so once it is published, rewriting it would rewrite shared history —
 * a conflict-with-current-state refusal the route boundary maps to a `409`.
 */
export class CommitAlreadyPushedError extends DomainError {
  readonly name = 'CommitAlreadyPushedError';

  /** Builds the refusal with the fixed message the caller is shown. */
  constructor() {
    super('The most recent commit has already been pushed and cannot be amended');
  }
}
