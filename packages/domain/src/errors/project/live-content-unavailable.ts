import { DomainError } from '../domain-error';

/**
 * Raised when a document's live collaborative content could not be read while
 * cloning. The clone fails rather than substituting last-saved content, so a
 * copy can never silently differ from what collaborators see. Maps to HTTP 503.
 *
 * This is the one clone error that carries a path, and the value is deliberately
 * narrow: the project-relative node path the caller already sees in their own
 * file tree, never a storage path resolved against the file-store root.
 */
export class LiveContentUnavailableError extends DomainError {
  readonly name = 'LiveContentUnavailableError';

  /**
   * @param path - Project-relative path of the document whose live content
   * could not be read, as it appears in the source project's file tree.
   */
  constructor(readonly path: string) {
    super(`Could not read the current content of ${path}`);
  }
}
