import { DomainError } from '../domain-error';

/**
 * Raised when a git use case that reads or acts against a project's working tree is asked to run
 * for a project with no `GitRepository` link. Unlike `RepositoryAlreadyConnectedError` (a write-side
 * conflict), this is a read-side "there is nothing here to read" refusal — the route boundary maps
 * it to a `404`, the same way a missing project or file node would be.
 */
export class RepositoryNotConnectedError extends DomainError {
  readonly name = 'RepositoryNotConnectedError';

  /** Builds the refusal with the fixed message the caller is shown. */
  constructor() {
    super('This project has no connected Git repository');
  }
}
