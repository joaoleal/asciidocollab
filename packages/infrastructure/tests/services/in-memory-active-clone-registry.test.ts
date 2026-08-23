import { UserId } from '@asciidocollab/domain';
import { InMemoryActiveCloneRegistry } from '../../src/services/in-memory-active-clone-registry';

const ALICE = '550e8400-e29b-41d4-a716-446655440001';
const BOB = '550e8400-e29b-41d4-a716-446655440002';

describe('InMemoryActiveCloneRegistry', () => {
  let registry: InMemoryActiveCloneRegistry;

  beforeEach(() => {
    registry = new InMemoryActiveCloneRegistry();
  });

  describe('tryAcquire', () => {
    it('grants the slot to a user who holds nothing', () => {
      expect(registry.tryAcquire(UserId.create(ALICE))).toBe(true);
    });

    it('refuses a second acquisition while the first is still held', () => {
      registry.tryAcquire(UserId.create(ALICE));

      expect(registry.tryAcquire(UserId.create(ALICE))).toBe(false);
    });

    it('keeps refusing on every further attempt, not just the second', () => {
      registry.tryAcquire(UserId.create(ALICE));

      expect(registry.tryAcquire(UserId.create(ALICE))).toBe(false);
      expect(registry.tryAcquire(UserId.create(ALICE))).toBe(false);
    });

    it('matches on the id value, not on object identity', () => {
      registry.tryAcquire(UserId.create(ALICE));

      expect(registry.tryAcquire(UserId.create(ALICE))).toBe(false);
    });

    it('grants the slot again once the holder released it', () => {
      registry.tryAcquire(UserId.create(ALICE));
      registry.release(UserId.create(ALICE));

      expect(registry.tryAcquire(UserId.create(ALICE))).toBe(true);
    });
  });

  describe('independence between users', () => {
    it('grants a second user a slot while the first still holds one', () => {
      registry.tryAcquire(UserId.create(ALICE));

      expect(registry.tryAcquire(UserId.create(BOB))).toBe(true);
    });

    it('leaves the other user holding when one of them releases', () => {
      registry.tryAcquire(UserId.create(ALICE));
      registry.tryAcquire(UserId.create(BOB));

      registry.release(UserId.create(ALICE));

      expect(registry.tryAcquire(UserId.create(BOB))).toBe(false);
      expect(registry.tryAcquire(UserId.create(ALICE))).toBe(true);
    });
  });

  describe('release', () => {
    it('does nothing when the user holds no slot', () => {
      expect(() => registry.release(UserId.create(ALICE))).not.toThrow();
      expect(registry.tryAcquire(UserId.create(ALICE))).toBe(true);
    });

    it('is idempotent — releasing twice does not bank a second acquisition', () => {
      registry.tryAcquire(UserId.create(ALICE));
      registry.release(UserId.create(ALICE));
      registry.release(UserId.create(ALICE));

      expect(registry.tryAcquire(UserId.create(ALICE))).toBe(true);
      expect(registry.tryAcquire(UserId.create(ALICE))).toBe(false);
    });
  });

  describe('per-instance state', () => {
    it('does not let one registry see slots held in another', () => {
      const other = new InMemoryActiveCloneRegistry();
      registry.tryAcquire(UserId.create(ALICE));

      expect(other.tryAcquire(UserId.create(ALICE))).toBe(true);
    });

    it('does not let a release on one registry free a slot held in another', () => {
      const other = new InMemoryActiveCloneRegistry();
      registry.tryAcquire(UserId.create(ALICE));

      other.release(UserId.create(ALICE));

      expect(registry.tryAcquire(UserId.create(ALICE))).toBe(false);
    });

    it('starts every new registry empty, carrying nothing over from a previous one', () => {
      registry.tryAcquire(UserId.create(ALICE));
      registry.tryAcquire(UserId.create(BOB));

      const fresh = new InMemoryActiveCloneRegistry();

      expect(fresh.tryAcquire(UserId.create(ALICE))).toBe(true);
      expect(fresh.tryAcquire(UserId.create(BOB))).toBe(true);
    });
  });
});
