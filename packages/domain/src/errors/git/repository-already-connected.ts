import { DomainError } from '../domain-error';

/**
 * Raised when `ConnectRepository` is asked to connect a project that already has a
 * `GitRepository` link. A project has a strict 1:1 relationship with a remote (data-model.md), so
 * reconnecting requires disconnecting first — this refusal is returned before anything is checked
 * against the remote or persisted, rather than surfacing as a raw storage-layer conflict.
 */
export class RepositoryAlreadyConnectedError extends DomainError {
  readonly name = 'RepositoryAlreadyConnectedError';

  constructor() {
    super('This project is already connected to a remote repository');
  }
}
