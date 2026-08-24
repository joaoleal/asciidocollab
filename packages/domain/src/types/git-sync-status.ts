/**
 * The synchronisation state of a project's connected `GitRepository` relative
 * to its remote, as last observed by a fetch/status check.
 */
export type GitSyncStatus = 'UP_TO_DATE' | 'AHEAD' | 'BEHIND' | 'DIVERGED' | 'CONFLICTED' | 'DISCONNECTED';

/** The default sync status for a newly connected or initialized repository. */
export const DEFAULT_GIT_SYNC_STATUS: GitSyncStatus = 'UP_TO_DATE';
