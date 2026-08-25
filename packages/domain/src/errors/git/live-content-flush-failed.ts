import { DomainError } from '../domain-error';

/**
 * Raised when a staged file's current collaborative content could not be read while preparing a
 * commit. The commit flushes each staged open document's live editor text before recording it; if
 * any such read fails, the whole commit is aborted rather than recording a mix of live and stale
 * content — so no partial write and no git commit happen. Carries the offending file's path so the
 * route or UI can name exactly which file could not be read.
 */
export class LiveContentFlushFailedError extends DomainError {
  readonly name = 'LiveContentFlushFailedError';

  /**
   * @param path - Workspace-relative path of the file whose live content could not be read.
   */
  constructor(public readonly path: string) {
    super(
      `Could not read the current collaborative content for "${path}"; the commit was aborted, so no changes were written`,
    );
  }
}
