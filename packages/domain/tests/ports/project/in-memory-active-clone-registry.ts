import { UserId } from '../../../src/value-objects/ids/user-id';
import { ActiveCloneRegistry } from '../../../src/ports/project/active-clone-registry';

/** In-memory implementation of ActiveCloneRegistry for use in tests. */
export class InMemoryActiveCloneRegistry implements ActiveCloneRegistry {
  private readonly holders = new Set<string>();

  /** Claims the slot for the user, or reports that the user already holds it. */
  tryAcquire(userId: UserId): boolean {
    if (this.holders.has(userId.value)) return false;
    this.holders.add(userId.value);
    return true;
  }

  /** Frees the user's slot; releasing an unheld user changes nothing. */
  release(userId: UserId): void {
    this.holders.delete(userId.value);
  }
}
