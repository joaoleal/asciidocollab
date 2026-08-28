import { VerifyEmailUseCase } from '../../../src/use-cases/auth/verify-email';
import { InMemoryUserRepository } from '../../ports/user/in-memory-user.repository';
import { InMemoryEmailVerificationTokenRepository } from '../../ports/auth-tokens/in-memory-email-verification-token.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { EmailVerificationToken } from '../../../src/entities/email-verification-token';
import { EmailVerificationTokenId } from '../../../src/value-objects/ids/email-verification-token-id';
import { User } from '../../../src/entities/user';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Email } from '../../../src/value-objects/identity/email';
import { Timestamps } from '../../../src/value-objects/common/timestamps';
import { InvalidTokenError } from '../../../src/errors/auth/invalid-token';
import type { TokenGenerator } from '../../../src/services/token-generator';
import { randomUUID } from 'crypto';

const RAW_TOKEN = 'verify-raw-token';
const HASHED_TOKEN = `hashed:${RAW_TOKEN}`;
const tokenGenerator: TokenGenerator = {
  generatePasswordResetToken: jest.fn(),
  generateInvitationToken: jest.fn(),
  generateEmailVerificationToken: jest.fn(),
  hashToken: (t) => `hashed:${t}`,
};

function makeUser(emailVerified = false): User {
  return new User(
    UserId.create(randomUUID()),
    Email.create('user@example.com'),
    'Test User',
    'hash',
    [],
    null,
    null,
    false,
    new Timestamps(),
    emailVerified,
    'SELF_REGISTERED',
  );
}

describe('VerifyEmailUseCase', () => {
  let userRepo: InMemoryUserRepository;
  let tokenRepo: InMemoryEmailVerificationTokenRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let useCase: VerifyEmailUseCase;
  let user: User;

  beforeEach(() => {
    userRepo = new InMemoryUserRepository();
    tokenRepo = new InMemoryEmailVerificationTokenRepository();
    auditLogRepo = new InMemoryAuditLogRepository();
    useCase = new VerifyEmailUseCase(userRepo, tokenRepo, auditLogRepo, tokenGenerator);
    user = makeUser(false);
  });

  test('returns InvalidTokenError when token not found', async () => {
    const result = await useCase.execute('unknown-raw');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InvalidTokenError);
  });

  test('returns InvalidTokenError when token is expired', async () => {
    await userRepo.save(user);
    const token = new EmailVerificationToken(
      EmailVerificationTokenId.create(randomUUID()),
      user.id,
      HASHED_TOKEN,
      new Date(Date.now() - 1000),
      null,
      new Date(),
    );
    await tokenRepo.save(token);

    const result = await useCase.execute(RAW_TOKEN);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InvalidTokenError);
  });

  test('returns InvalidTokenError when token already used', async () => {
    await userRepo.save(user);
    const token = new EmailVerificationToken(
      EmailVerificationTokenId.create(randomUUID()),
      user.id,
      HASHED_TOKEN,
      new Date(Date.now() + 86_400_000),
      new Date(),
      new Date(),
    );
    await tokenRepo.save(token);

    const result = await useCase.execute(RAW_TOKEN);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InvalidTokenError);
  });

  test('success: token marked usedAt, user emailVerified set true, audit log written', async () => {
    await userRepo.save(user);
    const token = new EmailVerificationToken(
      EmailVerificationTokenId.create(randomUUID()),
      user.id,
      HASHED_TOKEN,
      new Date(Date.now() + 86_400_000),
      null,
      new Date(),
    );
    await tokenRepo.save(token);

    const result = await useCase.execute(RAW_TOKEN);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.userId.value).toBe(user.id.value);
      expect(typeof result.value.isAdmin).toBe('boolean');

      const updatedUser = await userRepo.findById(user.id);
      expect(updatedUser?.emailVerified).toBe(true);

      const updatedToken = await tokenRepo.findByTokenHash(HASHED_TOKEN);
      expect(updatedToken?.usedAt).not.toBeNull();

      const logs = await auditLogRepo.findAll();
      expect(logs.some((l) => l.action === 'auth.email_verified')).toBe(true);
    }
  });

  test('returns InvalidTokenError when the token names an account that no longer exists', async () => {
    const token = new EmailVerificationToken(
      EmailVerificationTokenId.create(randomUUID()),
      user.id,
      HASHED_TOKEN,
      new Date(Date.now() + 86_400_000),
      null,
      new Date(),
    );
    await tokenRepo.save(token);

    const result = await useCase.execute(RAW_TOKEN);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InvalidTokenError);
    const untouched = await tokenRepo.findByTokenHash(HASHED_TOKEN);
    expect(untouched?.usedAt).toBeNull();
    expect(await auditLogRepo.findAll()).toHaveLength(0);
  });
});
