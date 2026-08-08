// Failing domain unit tests for ConfirmEmailChangeUseCase
import { ConfirmEmailChangeUseCase } from '../../../src/use-cases/auth/confirm-email-change';
import { User } from '../../../src/entities/user';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Email } from '../../../src/value-objects/identity/email';
import { Timestamps } from '../../../src/value-objects/common/timestamps';
import { EmailChangeToken } from '../../../src/entities/email-change-token';
import { EmailChangeTokenId } from '../../../src/value-objects/ids/email-change-token-id';
import { InMemoryEmailChangeTokenRepository } from '../../ports/auth-tokens/in-memory-email-change-token.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { UserRepository } from '../../../src/ports/user/user.repository';
import { TokenGenerator } from '../../../src/services/token-generator';

const USER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440000');

function createTestUser(): User {
  return new User(
    USER_ID,
    Email.create('old@example.com'),
    'Test User',
    'password-hash',
    [],
    null,
    null,
    false,
    new Timestamps(),
  );
}

function makeTokenGenerator(rawToken = 'raw-token'): TokenGenerator {
  return {
    generatePasswordResetToken: jest.fn(),
    hashToken: jest.fn().mockReturnValue(`hashed-${rawToken}`),
    // Unused by this use case, but part of the port: a fake that omits them is not the collaborator
    // the production code is handed.
    generateInvitationToken: jest.fn(),
    generateEmailVerificationToken: jest.fn(),
  };
}

function createValidToken(tokenHash = 'hashed-raw-token'): EmailChangeToken {
  return new EmailChangeToken(
    EmailChangeTokenId.create('550e8400-e29b-41d4-a716-446655440001'),
    USER_ID,
    tokenHash,
    'new@example.com',
    new Date(Date.now() + 3_600_000),
    null,
  );
}

describe('ConfirmEmailChangeUseCase', () => {
  let tokenRepo: InMemoryEmailChangeTokenRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let userRepo: UserRepository;
  let tokenGenerator: TokenGenerator;
  let useCase: ConfirmEmailChangeUseCase;

  beforeEach(() => {
    tokenRepo = new InMemoryEmailChangeTokenRepository();
    auditRepo = new InMemoryAuditLogRepository();
    const testUser = createTestUser();
    userRepo = {
      findById: jest.fn().mockResolvedValue(testUser),
      findByEmail: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
      hasAny: jest.fn(),
    } as unknown as UserRepository;
    tokenGenerator = makeTokenGenerator('raw-token');
    useCase = new ConfirmEmailChangeUseCase(tokenRepo, userRepo, tokenGenerator, auditRepo);
  });

  test('happy path updates user email to pendingEmail and marks token used', async () => {
    const token = createValidToken('hashed-raw-token');
    await tokenRepo.save(token);

    const result = await useCase.execute('raw-token');
    expect(result.success).toBe(true);

    const markedToken = await tokenRepo.findByTokenHash('hashed-raw-token');
    expect(markedToken?.isUsed).toBe(true);

    const savedUser = (userRepo.save as jest.Mock).mock.calls[0][0] as User;
    expect(savedUser.email.value).toBe('new@example.com');
  });

  test('records auth.email_changed with previous and new email metadata on success', async () => {
    const token = createValidToken('hashed-raw-token');
    await tokenRepo.save(token);

    const result = await useCase.execute('raw-token', { ipAddress: '203.0.113.7', userAgent: 'jest' });
    expect(result.success).toBe(true);

    const audits = await auditRepo.findAll();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('auth.email_changed');
    expect(audits[0].userId?.value).toBe(USER_ID.value);
    expect(audits[0].resourceType).toBe('User');
    expect(audits[0].resourceId).toBe(USER_ID.value);
    expect(audits[0].metadata.previousEmail).toBe('old@example.com');
    expect(audits[0].metadata.newEmail).toBe('new@example.com');
    expect(audits[0].metadata.origin).toEqual({ ipAddress: '203.0.113.7', userAgent: 'jest' });
  });

  test('a failed audit write does NOT fail the email change (failure reason is business-only) and is logged', async () => {
    const token = createValidToken('hashed-raw-token');
    await tokenRepo.save(token);
    const throwingAudit = { save: jest.fn().mockRejectedValue(new Error('audit db down')) } as never;
    const logger = { warn: jest.fn() };
    const useCaseWithLogger = new ConfirmEmailChangeUseCase(
      tokenRepo, userRepo, tokenGenerator, throwingAudit, logger,
    );

    // The email change (the business operation) committed and the single-use token was
    // consumed before the audit write, so an audit-store failure must NOT surface as the
    // result. The change succeeds; only the audit failure is logged.
    const result = await useCaseWithLogger.execute('raw-token');
    expect(result.success).toBe(true);
    const savedUser = (userRepo.save as jest.Mock).mock.calls[0][0] as User;
    expect(savedUser.email.value).toBe('new@example.com');
    expect(logger.warn).toHaveBeenCalled();
  });

  test('does not record an audit event on an invalid token', async () => {
    const result = await useCase.execute('nonexistent-token');
    expect(result.success).toBe(false);
    expect(await auditRepo.findAll()).toHaveLength(0);
  });

  test('expired token returns InvalidTokenError', async () => {
    const expiredToken = new EmailChangeToken(
      EmailChangeTokenId.create('550e8400-e29b-41d4-a716-446655440001'),
      USER_ID,
      'hashed-raw-token',
      'new@example.com',
      new Date(Date.now() - 1000),
      null,
    );
    await tokenRepo.save(expiredToken);

    const result = await useCase.execute('raw-token');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.name).toBe('InvalidTokenError');
    }
  });

  test('already-used token returns InvalidTokenError', async () => {
    const usedToken = new EmailChangeToken(
      EmailChangeTokenId.create('550e8400-e29b-41d4-a716-446655440001'),
      USER_ID,
      'hashed-raw-token',
      'new@example.com',
      new Date(Date.now() + 3_600_000),
      new Date(),
    );
    await tokenRepo.save(usedToken);

    const result = await useCase.execute('raw-token');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.name).toBe('InvalidTokenError');
    }
  });

  test('token not found returns InvalidTokenError', async () => {
    const result = await useCase.execute('nonexistent-token');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.name).toBe('InvalidTokenError');
    }
  });
});
