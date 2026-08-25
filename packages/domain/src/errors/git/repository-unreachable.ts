import { DomainError } from '../domain-error';

/**
 * Raised when a remote Git repository cannot be reached at all — the host could not be resolved
 * or connected to, or the remote does not exist. Distinct from {@link AuthenticationFailedError},
 * which means the remote was reached but the supplied credential was rejected. Carries no network
 * or process detail (Security Constitution) — those are for the observability sink, not the caller.
 */
export class RepositoryUnreachableError extends DomainError {
  readonly name = 'RepositoryUnreachableError';

  constructor() {
    super('The remote repository could not be reached');
  }
}
