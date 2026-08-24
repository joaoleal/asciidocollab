import { DomainError } from '../domain-error';

/**
 * Generic failure raised when a `GitCommandRunner` action cannot complete (for example,
 * the project's working tree is missing or not yet initialized, or the underlying `git`
 * process failed). Carries no process output, stack trace, or other internals (Security
 * Constitution) — a use case needing a more specific, user-facing category should
 * translate to one of the feature's narrower typed errors (e.g. `RepositoryUnreachableError`)
 * as those are introduced by the story task that needs them.
 */
export class GitCommandFailedError extends DomainError {
  readonly name = 'GitCommandFailedError';

  /** @param message - A safe, human-readable description of the failure. */
  constructor(message: string) {
    super(message);
  }
}
