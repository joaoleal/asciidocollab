import { DomainError } from '../domain-error';

/**
 * Raised when `InitializeRepository` is asked to publish an existing project onto a remote that
 * already has commits. Publishing onto a non-empty remote would either overwrite its history or
 * silently diverge from it — neither is acceptable, so this refusal stops the operation before
 * anything is initialized locally or pushed. The caller should be guided to import that remote's
 * existing content instead (`ImportRepositoryUseCase`), not to retry initialize.
 */
export class RemoteAlreadyInitializedError extends DomainError {
  readonly name = 'RemoteAlreadyInitializedError';

  constructor() {
    super('The remote repository already has commits; import it instead of initializing');
  }
}
