import { DomainError } from '../domain-error';

/**
 * Raised when a push is rejected because the remote branch has commits the local branch does not
 * — a non-fast-forward push (git's `! [rejected] ... (non-fast-forward)` / `(fetch first)`). The
 * caller must pull (or otherwise reconcile) the remote's newer commits before pushing again.
 * Distinct from {@link RepositoryUnreachableError} (the remote could not be reached at all) and
 * {@link AuthenticationFailedError} (the remote rejected the credential) — this means the remote
 * was reached, the credential was accepted, and the push itself was refused because it was not a
 * fast-forward.
 */
export class NonFastForwardError extends DomainError {
  readonly name = 'NonFastForwardError';

  /**
   * @param branch - The branch the push was rejected for, when known.
   */
  constructor(public readonly branch?: string) {
    super(
      branch
        ? `The remote branch '${branch}' has commits this branch does not — pull before pushing again`
        : 'The remote branch has commits this branch does not — pull before pushing again',
    );
  }
}
