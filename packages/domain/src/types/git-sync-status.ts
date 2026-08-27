/**
 * The synchronisation state of a project's connected `GitRepository` relative
 * to its remote, as last observed by a fetch/status check.
 *
 * `NEEDS_REAUTH` is set when the stored credential is rejected by the remote (an authentication
 * failure, distinct from an unreachable remote): the repository stays connected but cannot sync
 * until its credential is rotated, and the background refresh scheduler skips it until then.
 */
export type GitSyncStatus =
  | 'UP_TO_DATE'
  | 'AHEAD'
  | 'BEHIND'
  | 'DIVERGED'
  | 'CONFLICTED'
  | 'DISCONNECTED'
  | 'NEEDS_REAUTH';

/** The default sync status for a newly connected or initialized repository. */
export const DEFAULT_GIT_SYNC_STATUS: GitSyncStatus = 'UP_TO_DATE';
