import { PrismaClient } from '@prisma/client';
import { Email, EmailChangeToken, EmailChangeTokenId, User, UserId } from '@asciidocollab/domain';
import { PrismaEmailChangeTokenRepository } from '../../../src/persistence/auth-tokens/prisma-email-change-token.repository';
import { PrismaUserRepository } from '../../../src/persistence/user/prisma-user.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../../helpers/prisma-test-container';
import { createTestUser } from '../../helpers/test-data';
import { randomUUID } from 'crypto';

/** One hour, the production lifetime of an email-change token. */
const HOUR_MS = 3_600_000;

function makeToken(
  userId: UserId,
  overrides?: {
    id?: string;
    tokenHash?: string;
    pendingEmail?: string;
    expiresAt?: Date;
    usedAt?: Date | null;
    createdAt?: Date;
  },
): EmailChangeToken {
  return new EmailChangeToken(
    EmailChangeTokenId.create(overrides?.id ?? randomUUID()),
    userId,
    overrides?.tokenHash ?? `hash-${randomUUID()}`,
    overrides?.pendingEmail ?? `pending-${randomUUID()}@example.com`,
    overrides?.expiresAt ?? new Date(Date.now() + HOUR_MS),
    overrides?.usedAt ?? null,
    overrides?.createdAt ?? new Date(),
  );
}

describe('PrismaEmailChangeTokenRepository', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let repo: PrismaEmailChangeTokenRepository;
  let userRepo: PrismaUserRepository;

  async function saveUser(): Promise<User> {
    const user = createTestUser({ email: Email.create(`change-${randomUUID()}@example.com`) });
    await userRepo.save(user);
    return user;
  }

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    repo = new PrismaEmailChangeTokenRepository(client);
    userRepo = new PrismaUserRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.emailChangeToken.deleteMany();
    await client.user.deleteMany();
  });

  describe('save', () => {
    it('persists every field of a new token', async () => {
      const user = await saveUser();
      const expiresAt = new Date(Date.now() + HOUR_MS);
      const createdAt = new Date(Date.now() - 5000);
      const token = makeToken(user.id, {
        tokenHash: 'hash-persisted',
        pendingEmail: 'new-address@example.com',
        expiresAt,
        createdAt,
      });

      await repo.save(token);

      const row = await client.emailChangeToken.findUniqueOrThrow({ where: { id: token.id.value } });
      expect(row.userId).toBe(user.id.value);
      expect(row.tokenHash).toBe('hash-persisted');
      expect(row.pendingEmail).toBe('new-address@example.com');
      expect(row.expiresAt.getTime()).toBe(expiresAt.getTime());
      expect(row.createdAt.getTime()).toBe(createdAt.getTime());
      expect(row.usedAt).toBeNull();
    });

    it('updates the existing row instead of inserting a second one', async () => {
      const user = await saveUser();
      const token = makeToken(user.id, { tokenHash: 'hash-upsert', pendingEmail: 'first@example.com' });
      await repo.save(token);

      const usedAt = new Date(Date.now() - 1000);
      await repo.save(
        new EmailChangeToken(
          token.id,
          token.userId,
          token.tokenHash,
          'second@example.com',
          token.expiresAt,
          usedAt,
          token.createdAt,
        ),
      );

      const rows = await client.emailChangeToken.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(token.id.value);
      expect(rows[0].pendingEmail).toBe('second@example.com');
      expect(rows[0].usedAt?.getTime()).toBe(usedAt.getTime());
    });

    it('rejects a second token that reuses another token\'s hash', async () => {
      const user = await saveUser();
      await repo.save(makeToken(user.id, { tokenHash: 'hash-shared' }));

      await expect(repo.save(makeToken(user.id, { tokenHash: 'hash-shared' }))).rejects.toMatchObject({
        code: 'P2002',
      });
      expect(await client.emailChangeToken.count()).toBe(1);
    });
  });

  describe('findByTokenHash', () => {
    it('maps the stored row onto the domain entity', async () => {
      const user = await saveUser();
      const expiresAt = new Date(Date.now() + HOUR_MS);
      const createdAt = new Date(Date.now() - 60_000);
      const token = makeToken(user.id, {
        tokenHash: 'hash-mapped',
        pendingEmail: 'mapped@example.com',
        expiresAt,
        createdAt,
      });
      await repo.save(token);

      const found = await repo.findByTokenHash('hash-mapped');

      expect(found).toBeInstanceOf(EmailChangeToken);
      expect(found?.id.value).toBe(token.id.value);
      expect(found?.userId.value).toBe(user.id.value);
      expect(found?.tokenHash).toBe('hash-mapped');
      expect(found?.pendingEmail).toBe('mapped@example.com');
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
      const wanted = makeToken(owner.id, { tokenHash: 'hash-wanted', pendingEmail: 'wanted@example.com' });
      await repo.save(wanted);
      await repo.save(makeToken(other.id, { tokenHash: 'hash-unwanted', pendingEmail: 'unwanted@example.com' }));

      const found = await repo.findByTokenHash('hash-wanted');

      expect(found?.id.value).toBe(wanted.id.value);
      expect(found?.userId.value).toBe(owner.id.value);
      expect(found?.pendingEmail).toBe('wanted@example.com');
    });

    // The hash lookup deliberately applies no validity filter — the caller decides what an expired or
    // already-consumed token means. These two pin that down so a filter cannot be added unnoticed.
    it('returns a token that has already been used', async () => {
      const user = await saveUser();
      const usedAt = new Date(Date.now() - 1000);
      await repo.save(makeToken(user.id, { tokenHash: 'hash-used', usedAt }));

      const found = await repo.findByTokenHash('hash-used');

      expect(found?.usedAt?.getTime()).toBe(usedAt.getTime());
      expect(found?.isUsed).toBe(true);
    });

    it('returns a token that has expired', async () => {
      const user = await saveUser();
      await repo.save(makeToken(user.id, { tokenHash: 'hash-expired', expiresAt: new Date(Date.now() - 1) }));

      const found = await repo.findByTokenHash('hash-expired');

      expect(found).not.toBeNull();
      expect(found?.isExpired).toBe(true);
    });
  });

  describe('findActiveByUserId', () => {
    it('returns the unused, unexpired token for that user', async () => {
      const user = await saveUser();
      const token = makeToken(user.id, { tokenHash: 'hash-active', pendingEmail: 'active@example.com' });
      await repo.save(token);

      const found = await repo.findActiveByUserId(user.id);

      expect(found).toBeInstanceOf(EmailChangeToken);
      expect(found?.id.value).toBe(token.id.value);
      expect(found?.pendingEmail).toBe('active@example.com');
      expect(found?.isValid).toBe(true);
    });

    it('ignores used and expired tokens and returns the active one', async () => {
      const user = await saveUser();
      const now = Date.now();
      const active = makeToken(user.id, { tokenHash: 'hash-active' });
      await repo.save(makeToken(user.id, { tokenHash: 'hash-used', usedAt: new Date(now - 1000) }));
      await repo.save(makeToken(user.id, { tokenHash: 'hash-expired', expiresAt: new Date(now - 1) }));
      await repo.save(active);

      const found = await repo.findActiveByUserId(user.id);

      expect(found?.id.value).toBe(active.id.value);
      expect(found?.tokenHash).toBe('hash-active');
    });

    it('returns null when the user\'s only token has been used', async () => {
      const user = await saveUser();
      await repo.save(makeToken(user.id, { tokenHash: 'hash-used', usedAt: new Date(Date.now() - 1000) }));

      expect(await repo.findActiveByUserId(user.id)).toBeNull();
    });

    it('still returns a token that expires shortly in the future', async () => {
      const user = await saveUser();
      await repo.save(makeToken(user.id, { tokenHash: 'hash-nearly-due', expiresAt: new Date(Date.now() + 30_000) }));

      const found = await repo.findActiveByUserId(user.id);

      expect(found?.tokenHash).toBe('hash-nearly-due');
    });

    it('returns null for a token that expired a millisecond ago', async () => {
      const user = await saveUser();
      await repo.save(makeToken(user.id, { tokenHash: 'hash-just-expired', expiresAt: new Date(Date.now() - 1) }));

      expect(await repo.findActiveByUserId(user.id)).toBeNull();
      // Filtered out, not cleaned up.
      expect(await client.emailChangeToken.count()).toBe(1);
    });

    it('does not return another user\'s active token', async () => {
      const owner = await saveUser();
      const other = await saveUser();
      await repo.save(makeToken(other.id, { tokenHash: 'hash-theirs' }));

      expect(await repo.findActiveByUserId(owner.id)).toBeNull();
    });

    it('returns null for a user with no tokens at all', async () => {
      const user = await saveUser();

      expect(await repo.findActiveByUserId(user.id)).toBeNull();
    });
  });

  describe('markAsUsed', () => {
    it('stamps the given token and leaves the others untouched', async () => {
      const user = await saveUser();
      const target = makeToken(user.id, { tokenHash: 'hash-target', pendingEmail: 'target@example.com' });
      const bystander = makeToken(user.id, { tokenHash: 'hash-bystander' });
      await repo.save(target);
      await repo.save(bystander);
      const usedAt = new Date(Date.now() - 1234);

      await repo.markAsUsed(target.id.value, usedAt);

      const targetRow = await client.emailChangeToken.findUniqueOrThrow({ where: { id: target.id.value } });
      const bystanderRow = await client.emailChangeToken.findUniqueOrThrow({ where: { id: bystander.id.value } });
      expect(targetRow.usedAt?.getTime()).toBe(usedAt.getTime());
      expect(targetRow.pendingEmail).toBe('target@example.com');
      expect(targetRow.expiresAt.getTime()).toBe(target.expiresAt.getTime());
      expect(bystanderRow.usedAt).toBeNull();
    });

    it('takes the token out of the active lookup', async () => {
      const user = await saveUser();
      const token = makeToken(user.id, { tokenHash: 'hash-consumed' });
      await repo.save(token);
      expect(await repo.findActiveByUserId(user.id)).not.toBeNull();

      await repo.markAsUsed(token.id.value, new Date());

      expect(await repo.findActiveByUserId(user.id)).toBeNull();
      // The row survives consumption; only the active lookup stops seeing it.
      expect(await repo.findByTokenHash('hash-consumed')).not.toBeNull();
    });

    it('rejects for an id that does not exist', async () => {
      await expect(repo.markAsUsed(randomUUID(), new Date())).rejects.toMatchObject({ code: 'P2025' });
    });
  });

  describe('deleteByUserId', () => {
    it('removes every token of that user, whatever its state', async () => {
      const user = await saveUser();
      const now = Date.now();
      await repo.save(makeToken(user.id, { tokenHash: 'hash-active' }));
      await repo.save(makeToken(user.id, { tokenHash: 'hash-used', usedAt: new Date(now - 1000) }));
      await repo.save(makeToken(user.id, { tokenHash: 'hash-expired', expiresAt: new Date(now - 1) }));

      await repo.deleteByUserId(user.id);

      expect(await client.emailChangeToken.count()).toBe(0);
    });

    it('leaves another user\'s tokens in place', async () => {
      const owner = await saveUser();
      const other = await saveUser();
      await repo.save(makeToken(owner.id, { tokenHash: 'hash-mine' }));
      const theirs = makeToken(other.id, { tokenHash: 'hash-theirs' });
      await repo.save(theirs);

      await repo.deleteByUserId(owner.id);

      const remaining = await client.emailChangeToken.findMany();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(theirs.id.value);
    });

    it('is a no-op for a user with no tokens', async () => {
      const owner = await saveUser();
      const other = await saveUser();
      await repo.save(makeToken(other.id, { tokenHash: 'hash-theirs' }));

      await expect(repo.deleteByUserId(owner.id)).resolves.toBeUndefined();
      expect(await client.emailChangeToken.count()).toBe(1);
    });
  });
});
