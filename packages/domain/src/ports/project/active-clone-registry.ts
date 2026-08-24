import type { UserId } from '../../value-objects/ids/user-id';

/**
 * Tracks which users currently have a clone running, so a user cannot start a
 * second one while the first is still copying. Cloning reads and rewrites a
 * whole project, so this bounds the concurrent cost a single user can impose;
 * different users are always independent of one another.
 */
export interface ActiveCloneRegistry {
  /**
   * Claims the clone slot for a user, atomically with respect to that user.
   *
   * @param userId - The user asking to start a clone.
   * @returns True when the slot was claimed; false when that user already holds it.
   */
  tryAcquire(userId: UserId): boolean;

  /**
   * Frees a user's clone slot. Releasing a user who holds nothing is a no-op, so
   * this is safe to call unconditionally from a `finally`.
   *
   * @param userId - The user whose slot to free.
   */
  release(userId: UserId): void;
}
