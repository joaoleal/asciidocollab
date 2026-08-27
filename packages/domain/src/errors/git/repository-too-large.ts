import { DomainError } from '../domain-error';

/**
 * Raised when a repository being imported/cloned exceeds the configured maximum size. Enforced at
 * clone/import time only — never per-commit — so an oversized remote fails gracefully instead of
 * hanging or exhausting memory while materializing its tracked files. Carries no size, path, or
 * other internal detail (Security Constitution): the caller learns only that the repository was
 * too large, never by how much or what was being read when the limit was reached.
 */
export class RepositoryTooLargeError extends DomainError {
  readonly name = 'RepositoryTooLargeError';

  /** Builds the refusal with the fixed message the caller is shown. */
  constructor() {
    super('The repository exceeds the maximum allowed size.');
  }
}
