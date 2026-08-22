import { PrismaClient } from '@prisma/client';
import { Email, PasswordResetToken, PasswordResetTokenId, User, UserId } from '@asciidocollab/domain';
import { PrismaPasswordResetTokenRepository } from '../../../src/persistence/auth-tokens/prisma-password-reset-token.repository';
import { PrismaUserRepository } from '../../../src/persistence/user/prisma-user.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../../helpers/prisma-test-container';
import { createTestUser } from '../../helpers/test-data';
import { randomUUID } from 'crypto';

/** One hour, the production lifetime of a reset token. */
const HOUR_MS = 3_600_000;

function makeToken(
  userId: UserId,
  overrides?: { id?: string; tokenHash?: string; expiresAt?: Date; usedAt?: Date | null; createdAt?: Date },
): PasswordResetToken {
  return new PasswordResetToken(
    PasswordResetTokenId.create(overrides?.id ?? randomUUID()),
    userId,
    overrides?.tokenHash ?? `hash-${randomUUID()}`,
    overrides?.expiresAt ?? new Date(Date.now() + HOUR_MS),
    overrides?.usedAt ?? null,
    overrides?.createdAt ?? new Date(),
  );
}

describe('PrismaPasswordResetTokenRepository', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let repo: PrismaPasswordResetTokenRepository;
  let userRepo: PrismaUserRepository;

  /** Distinct users so that "belongs to somebody else" is a real distinction, not a coincidence. */
  async function saveUser(): Promise<User> {
    const user = createTestUser({ email: Email.create(`reset-${randomUUID()}@example.com`) });
    await userRepo.save(user);
    return user;
  }

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    repo = new PrismaPasswordResetTokenRepository(client);
    userRepo = new PrismaUserRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.passwordResetToken.deleteMany();
    await client.user.deleteMany();
  });

  describe('save', () => {
    it('persists every field of a new token', async () => {
      const user = await saveUser();
      const expiresAt = new Date(Date.now() + HOUR_MS);
      const createdAt = new Date(Date.now() - 5000);
      const token = makeToken(user.id, { tokenHash: 'hash-persisted', expiresAt, createdAt });

      await repo.save(token);

      const row = await client.passwordResetToken.findUniqueOrThrow({ where: { id: token.id.value } });
      expect(row.userId).toBe(user.id.value);
      expect(row.tokenHash).toBe('hash-persisted');
      expect(row.expiresAt.getTime()).toBe(expiresAt.getTime());
      expect(row.createdAt.getTime()).toBe(createdAt.getTime());
      expect(row.usedAt).toBeNull();
    });

    it('updates the existing row instead of inserting a second one', async () => {
      const user = await saveUser();
      const token = makeToken(user.id, { tokenHash: 'hash-upsert' });
      await repo.save(token);

      const usedAt = new Date(Date.now() - 1000);
      await repo.save(
        new PasswordResetToken(token.id, token.userId, token.tokenHash, token.expiresAt, usedAt, token.createdAt),
      );

      const rows = await client.passwordResetToken.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(token.id.value);
      expect(rows[0].usedAt?.getTime()).toBe(usedAt.getTime());
    });

    it('rejects a second token that reuses another token\'s hash', async () => {
      const user = await saveUser();
      await repo.save(makeToken(user.id, { tokenHash: 'hash-shared' }));

      await expect(repo.save(makeToken(user.id, { tokenHash: 'hash-shared' }))).rejects.toMatchObject({
        code: 'P2002',
      });
      expect(await client.passwordResetToken.count()).toBe(1);
    });
  });

  describe('findByTokenHash', () => {
    it('maps the stored row onto the domain entity', async () => {
      const user = await saveUser();
      const expiresAt = new Date(Date.now() + HOUR_MS);
      const createdAt = new Date(Date.now() - 60_000);
      const token = makeToken(user.id, { tokenHash: 'hash-mapped', expiresAt, createdAt });
      await repo.save(token);

      const found = await repo.findByTokenHash('hash-mapped');

      expect(found).toBeInstanceOf(PasswordResetToken);
      expect(found?.id.value).toBe(token.id.value);
      expect(found?.userId.value).toBe(user.id.value);
      expect(found?.tokenHash).toBe('hash-mapped');
      expect(found?.expiresAt.getTime()).toBe(expiresAt.getTime());
      expect(found?.createdAt.getTime()).toBe(createdAt.getTime());
      expect(found?.usedAt).toBeNull();
      expect(found?.isValid).toBe(true);
    });

    it('returns null when no token carries that hash', async () => {
      const user = await saveUser();
      await repo.save(makeToken(user.id, { tokenHash: 'hash-present' }));

      expect(await repo.findByTokenHash('hash-absent')).toBeNull();
    });

    it('returns the token carrying the hash, not another user\'s token', async () => {
      const owner = await saveUser();
      const other = await saveUser();
      const wanted = makeToken(owner.id, { tokenHash: 'hash-wanted' });
      await repo.save(wanted);
      await repo.save(makeToken(other.id, { tokenHash: 'hash-unwanted' }));

      const found = await repo.findByTokenHash('hash-wanted');

      expect(found?.id.value).toBe(wanted.id.value);
      expect(found?.userId.value).toBe(owner.id.value);
    });

    it('returns null for a token that has already been used', async () => {
      const user = await saveUser();
      await repo.save(makeToken(user.id, { tokenHash: 'hash-used', usedAt: new Date(Date.now() - 1000) }));

      expect(await repo.findByTokenHash('hash-used')).toBeNull();
    });

    it('still returns a token that expires shortly in the future', async () => {
      const user = await saveUser();
      await repo.save(
        makeToken(user.id, { tokenHash: 'hash-nearly-due', expiresAt: new Date(Date.now() + 30_000) }),
      );

      const found = await repo.findByTokenHash('hash-nearly-due');

      expect(found).not.toBeNull();
      expect(found?.tokenHash).toBe('hash-nearly-due');
    });

    it('returns null for a token that expired a millisecond ago', async () => {
      const user = await saveUser();
      await repo.save(
        makeToken(user.id, { tokenHash: 'hash-just-expired', expiresAt: new Date(Date.now() - 1) }),
      );

      expect(await repo.findByTokenHash('hash-just-expired')).toBeNull();
      // The row itself is untouched: the lookup filters, it does not clean up.
      expect(await client.passwordResetToken.count({ where: { tokenHash: 'hash-just-expired' } })).toBe(1);
    });
  });

  describe('findByUserId', () => {
    it('returns only the tokens belonging to that user', async () => {
      const owner = await saveUser();
      const other = await saveUser();
      const mine = makeToken(owner.id, { tokenHash: 'hash-mine' });
      await repo.save(mine);
      await repo.save(makeToken(other.id, { tokenHash: 'hash-theirs' }));

      const found = await repo.findByUserId(owner.id);

      expect(found).toHaveLength(1);
      expect(found[0].id.value).toBe(mine.id.value);
      expect(found[0].tokenHash).toBe('hash-mine');
    });

    it('orders the tokens newest-created first', async () => {
      const user = await saveUser();
      const now = Date.now();
      const oldest = makeToken(user.id, { tokenHash: 'hash-oldest', createdAt: new Date(now - 20_000) });
      const middle = makeToken(user.id, { tokenHash: 'hash-middle', createdAt: new Date(now - 10_000) });
      const newest = makeToken(user.id, { tokenHash: 'hash-newest', createdAt: new Date(now) });
      // Saved out of order so a passing assertion cannot be insertion order in disguise.
      await repo.save(middle);
      await repo.save(oldest);
      await repo.save(newest);

      const found = await repo.findByUserId(user.id);

      expect(found.map((token) => token.tokenHash)).toEqual(['hash-newest', 'hash-middle', 'hash-oldest']);
    });

    it('includes used and expired tokens', async () => {
      const user = await saveUser();
      const now = Date.now();
      await repo.save(
        makeToken(user.id, { tokenHash: 'hash-history-used', createdAt: new Date(now - 2), usedAt: new Date(now - 1000) }),
      );
      await repo.save(
        makeToken(user.id, { tokenHash: 'hash-history-expired', createdAt: new Date(now - 1), expiresAt: new Date(now - 1) }),
      );

      const found = await repo.findByUserId(user.id);

      expect(found.map((token) => token.tokenHash).toSorted()).toEqual([
        'hash-history-expired',
        'hash-history-used',
      ]);
      expect(found.every((token) => token instanceof PasswordResetToken)).toBe(true);
    });

    it('returns an empty list for a user with no tokens', async () => {
      const withTokens = await saveUser();
      const withoutTokens = await saveUser();
      await repo.save(makeToken(withTokens.id));

      expect(await repo.findByUserId(withoutTokens.id)).toEqual([]);
    });
  });

  describe('markAsUsed', () => {
    it('stamps the given token and leaves the others untouched', async () => {
      const user = await saveUser();
      const target = makeToken(user.id, { tokenHash: 'hash-target' });
      const bystander = makeToken(user.id, { tokenHash: 'hash-bystander' });
      await repo.save(target);
      await repo.save(bystander);
      const usedAt = new Date(Date.now() - 1234);

      await repo.markAsUsed(target.id.value, usedAt);

      const targetRow = await client.passwordResetToken.findUniqueOrThrow({ where: { id: target.id.value } });
      const bystanderRow = await client.passwordResetToken.findUniqueOrThrow({ where: { id: bystander.id.value } });
      expect(targetRow.usedAt?.getTime()).toBe(usedAt.getTime());
      expect(targetRow.tokenHash).toBe('hash-target');
      expect(targetRow.expiresAt.getTime()).toBe(target.expiresAt.getTime());
      expect(bystanderRow.usedAt).toBeNull();
    });

    it('makes the token unfindable by hash afterwards', async () => {
      const user = await saveUser();
      const token = makeToken(user.id, { tokenHash: 'hash-consumed' });
      await repo.save(token);
      expect(await repo.findByTokenHash('hash-consumed')).not.toBeNull();

      await repo.markAsUsed(token.id.value, new Date());

      expect(await repo.findByTokenHash('hash-consumed')).toBeNull();
    });

    it('rejects for an id that does not exist', async () => {
      await expect(repo.markAsUsed(randomUUID(), new Date())).rejects.toMatchObject({ code: 'P2025' });
    });
  });

  describe('deleteExpired', () => {
    it('deletes only that user\'s expired tokens and returns how many went', async () => {
      const owner = await saveUser();
      const other = await saveUser();
      const now = Date.now();
      await repo.save(makeToken(owner.id, { tokenHash: 'hash-expired-1', expiresAt: new Date(now - 60_000) }));
      await repo.save(makeToken(owner.id, { tokenHash: 'hash-expired-2', expiresAt: new Date(now - 1) }));
      await repo.save(makeToken(owner.id, { tokenHash: 'hash-live', expiresAt: new Date(now + HOUR_MS) }));
      await repo.save(makeToken(other.id, { tokenHash: 'hash-other-expired', expiresAt: new Date(now - 60_000) }));

      const deleted = await repo.deleteExpired(owner.id);

      expect(deleted).toBe(2);
      const remaining = await client.passwordResetToken.findMany();
      expect(remaining.map((row) => row.tokenHash).toSorted()).toEqual(['hash-live', 'hash-other-expired']);
    });

    it('keeps a token that expires shortly in the future', async () => {
      const user = await saveUser();
      await repo.save(makeToken(user.id, { tokenHash: 'hash-nearly-due', expiresAt: new Date(Date.now() + 30_000) }));

      expect(await repo.deleteExpired(user.id)).toBe(0);
      expect(await client.passwordResetToken.count({ where: { tokenHash: 'hash-nearly-due' } })).toBe(1);
    });

    it('deletes an expired token even when it was already used', async () => {
      const user = await saveUser();
      const now = Date.now();
      await repo.save(
        makeToken(user.id, {
          tokenHash: 'hash-used-and-expired',
          expiresAt: new Date(now - 1),
          usedAt: new Date(now - 500),
        }),
      );

      expect(await repo.deleteExpired(user.id)).toBe(1);
      expect(await client.passwordResetToken.count()).toBe(0);
    });

    it('returns 0 when the user has nothing expired', async () => {
      const user = await saveUser();
      await repo.save(makeToken(user.id, { tokenHash: 'hash-live' }));

      expect(await repo.deleteExpired(user.id)).toBe(0);
      expect(await client.passwordResetToken.count()).toBe(1);
    });
  });
});
