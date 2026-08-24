import type { ActiveCloneRegistry, UserId } from '@asciidocollab/domain';

/**
 * Process-local {@link ActiveCloneRegistry} backed by a set of holding user ids.
 *
 * Cloning reads and rewrites a whole project, so this caps a single user at one
 * clone in flight while leaving other users unaffected. A single-process registry
 * is enough because the guard bounds the work one user can start on this instance;
 * it is not a distributed lock.
 */
export class InMemoryActiveCloneRegistry implements ActiveCloneRegistry {
  // Per-instance, never module-level: a shared set would be a hidden static singleton that every
  // composition root and every test in the process writes to, so one test's unreleased holder would
  // deny the next one. Its lifetime is the lifetime of the registry that owns it.
  private readonly holders = new Set<string>();

  /**
   * Claims the clone slot for a user. Runs to completion without awaiting, so
   * the check and the claim cannot interleave with another caller.
   *
   * @param userId - The user asking to start a clone.
   * @returns True when the slot was claimed; false when that user already holds it.
   */
  tryAcquire(userId: UserId): boolean {
    if (this.holders.has(userId.value)) return false;
    this.holders.add(userId.value);
    return true;
  }

  /**
   * Frees a user's clone slot. Releasing a user who holds nothing changes nothing,
   * so this is safe to call unconditionally from a `finally`.
   *
   * @param userId - The user whose slot to free.
   */
  release(userId: UserId): void {
    this.holders.delete(userId.value);
  }
}
