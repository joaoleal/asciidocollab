import { DomainError } from '../domain-error';

/**
 * Raised when a conflict resolution is attempted for a path that is not among the operation's
 * recorded `GitConflict` rows — either the path was never conflicting, or it belongs to a
 * different (or already-cleared) operation. Distinct from {@link NoConflictInProgressError} (no
 * conflicted operation at all): this means the operation exists and is awaiting resolution, but
 * the given path is not one of its conflicts.
 */
export class GitConflictNotFoundError extends DomainError {
  readonly name = 'GitConflictNotFoundError';

  /** @param path - The path that was not found among the operation's conflicts. */
  constructor(public readonly path: string) {
    super(`No conflict recorded for path '${path}'`);
  }
}
