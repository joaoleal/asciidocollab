/** @file The typed, non-leaky error vocabulary for git repository sync operations (wire codes). */

/**
 * The closed set of git-sync error categories that cross the API boundary. Each
 * maps to a fixed HTTP status and carries no internal detail (Security
 * Constitution). The domain expresses these as `DomainError` subclasses; this
 * union is the on-the-wire code the client can branch on.
 */
export type GitErrorCode =
  | 'repository_unreachable'
  | 'authentication_failed'
  | 'already_connected'
  | 'non_fast_forward'
  | 'merge_conflict'
  | 'git_operation_in_progress'
  | 'insufficient_role'
  | 'nothing_staged'
  | 'empty_commit_message'
  | 'remote_already_initialized'
  | 'remote_history_rewritten'
  | 'unresolved_conflicts'
  | 'nothing_to_undo';

/** The exhaustive, stable set of typed git-sync error codes. */
export const GIT_ERROR_CODES: readonly GitErrorCode[] = [
  'repository_unreachable',
  'authentication_failed',
  'already_connected',
  'non_fast_forward',
  'merge_conflict',
  'git_operation_in_progress',
  'insufficient_role',
  'nothing_staged',
  'empty_commit_message',
  'remote_already_initialized',
  'remote_history_rewritten',
  'unresolved_conflicts',
  'nothing_to_undo',
];

/** Narrows an arbitrary string to a {@link GitErrorCode}. */
export function isGitErrorCode(value: string): value is GitErrorCode {
  const codes: readonly string[] = GIT_ERROR_CODES;
  return codes.includes(value);
}

/** A typed git-sync error as returned in the API error envelope. */
export interface GitErrorDto {
  /** The stable, non-leaky error category. */
  code: GitErrorCode;
  /** A human-readable message safe to show to the client. */
  message: string;
}
