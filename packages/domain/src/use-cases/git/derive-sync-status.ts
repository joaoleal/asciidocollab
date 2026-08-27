import { GitSyncStatus } from '../../types/git-sync-status';

/**
 * Maps a local branch's behind/ahead counts (relative to its already-fetched remote-tracking ref)
 * to the closest `GitSyncStatus`. Purely positional — it never itself preserves `CONFLICTED`, which
 * a caller layers on top when the row already holds unresolved conflicts.
 *
 * @param behind - Commits the remote-tracking ref has that the local branch does not (`>= 0`).
 * @param ahead - Commits the local branch has that the remote-tracking ref does not (`>= 0`).
 * @returns `DIVERGED` when both sides have unique commits, `BEHIND`/`AHEAD` when only one does, and
 *   `UP_TO_DATE` when the two refs are level.
 */
export function deriveSyncStatus(behind: number, ahead: number): GitSyncStatus {
  if (behind > 0 && ahead > 0) return 'DIVERGED';
  if (behind > 0) return 'BEHIND';
  if (ahead > 0) return 'AHEAD';
  return 'UP_TO_DATE';
}
