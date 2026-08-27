import { DomainError } from '../domain-error';

/**
 * Raised when a remote Git repository was reached but rejected the supplied credential (an
 * invalid, expired, or insufficiently scoped access token). Distinct from
 * {@link RepositoryUnreachableError}, which means the remote could not be reached at all. Carries
 * no detail about the credential itself (Security Constitution) — only that it was rejected.
 */
export class AuthenticationFailedError extends DomainError {
  readonly name = 'AuthenticationFailedError';

  /** Builds the refusal with the fixed message the caller is shown. */
  constructor() {
    super('Authentication with the remote repository failed');
  }
}
