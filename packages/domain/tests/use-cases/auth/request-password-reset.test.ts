import { RequestPasswordResetUseCase } from '../../../src/use-cases/auth/request-password-reset';
import { User } from '../../../src/entities/user';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Email } from '../../../src/value-objects/identity/email';
import { Timestamps } from '../../../src/value-objects/common/timestamps';
import { UserRepository } from '../../../src/ports/user/user.repository';
import { TokenGenerator } from '../../../src/services/token-generator';
import { PasswordResetNotifier } from '../../../src/services/password-reset-notifier';
import { InMemoryPasswordResetTokenRepository } from '../../ports/auth-tokens/in-memory-password-reset-token.repository';
import { InMemoryAuthAttemptTelemetryRepository } from '../../ports/admin/in-memory-auth-attempt-telemetry.repository';
import { AUTH_ATTEMPT_PASSWORD_RESET_REQUEST } from '../../../src/entities/auth-attempt-telemetry';
import { UNKNOWN_IP } from '../../../src/use-cases/auth/record-auth-attempt';

const WINDOW_MS = 5 * 60_000;

const USER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440000');
const TEST_EMAIL = 'user@example.com';

function createTestUser(): User {
  return new User(
    USER_ID,
    Email.create(TEST_EMAIL),
    'Test User',
    'password-hash',
    [],
    null,
    null,
    false,
    new Timestamps(),
  );
}

function makeTokenGenerator(): TokenGenerator {
  return {
    generatePasswordResetToken: jest.fn().mockReturnValue({
      token: 'raw-token',
      hashedToken: 'hashed-token',
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
    hashToken: jest.fn().mockReturnValue('hashed-token'),
    // Unused by this use case, but part of the port: a fake that omits them is not the collaborator
    // the production code is handed.
    generateInvitationToken: jest.fn(),
    generateEmailVerificationToken: jest.fn(),
  };
}

function makeNotifier(): jest.Mocked<PasswordResetNotifier> {
  return { sendResetEmail: jest.fn().mockResolvedValue(undefined) };
}

describe('RequestPasswordResetUseCase', () => {
  let tokenRepo: InMemoryPasswordResetTokenRepository;
  let userRepo: UserRepository;
  let tokenGenerator: TokenGenerator;
  let notifier: jest.Mocked<PasswordResetNotifier>;

  beforeEach(() => {
    tokenRepo = new InMemoryPasswordResetTokenRepository();
    userRepo = {
      findByEmail: jest.fn().mockResolvedValue(createTestUser()),
      findById: jest.fn(),
      save: jest.fn(),
      hasAny: jest.fn(),
    } as unknown as UserRepository;
    tokenGenerator = makeTokenGenerator();
    notifier = makeNotifier();
  });

  test('known user: saves token and sends reset email', async () => {
    const useCase = new RequestPasswordResetUseCase(userRepo, tokenRepo, tokenGenerator, notifier);
    const result = await useCase.execute(Email.create(TEST_EMAIL));

    expect(result.success).toBe(true);
    const saved = await tokenRepo.findByTokenHash('hashed-token');
    expect(saved).not.toBeNull();
    expect(notifier.sendResetEmail).toHaveBeenCalledWith(TEST_EMAIL, 'raw-token');
  });

  test('unknown user: no token saved, notifier not called', async () => {
    (userRepo.findByEmail as jest.Mock).mockResolvedValue(null);
    const useCase = new RequestPasswordResetUseCase(userRepo, tokenRepo, tokenGenerator, notifier);
    const result = await useCase.execute(Email.create('ghost@example.com'));

    expect(result.success).toBe(true);
    const saved = await tokenRepo.findByTokenHash('hashed-token');
    expect(saved).toBeNull();
    expect(notifier.sendResetEmail).not.toHaveBeenCalled();
  });

  test('SMTP failure: notifier throws, use case still returns success', async () => {
    notifier.sendResetEmail.mockRejectedValue(new Error('SMTP down'));
    const useCase = new RequestPasswordResetUseCase(userRepo, tokenRepo, tokenGenerator, notifier);
    const result = await useCase.execute(Email.create(TEST_EMAIL));

    expect(result.success).toBe(true);
  });

  describe('reset-request telemetry (same coalesced/auto-purged mechanism as failed sign-ins)', () => {
    test('known user: records a password_reset_request bucket keyed by the attempted identifier', async () => {
      const telemetry = new InMemoryAuthAttemptTelemetryRepository();
      const useCase = new RequestPasswordResetUseCase(
        userRepo, tokenRepo, tokenGenerator, notifier,
        { repo: telemetry, windowSizeMs: WINDOW_MS },
      );

      await useCase.execute(Email.create(TEST_EMAIL), { ipAddress: '203.0.113.7' });

      const rows = await telemetry.findAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].eventType).toBe(AUTH_ATTEMPT_PASSWORD_RESET_REQUEST);
      expect(rows[0].identifier).toBe(TEST_EMAIL);
      expect(rows[0].ipAddress).toBe('203.0.113.7');
    });

    test('unknown user: still records (account-existence neutral, no enumeration via telemetry)', async () => {
      (userRepo.findByEmail as jest.Mock).mockResolvedValue(null);
      const telemetry = new InMemoryAuthAttemptTelemetryRepository();
      const useCase = new RequestPasswordResetUseCase(
        userRepo, tokenRepo, tokenGenerator, notifier,
        { repo: telemetry, windowSizeMs: WINDOW_MS },
      );

      await useCase.execute(Email.create('ghost@example.com'), {});

      const rows = await telemetry.findAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].eventType).toBe(AUTH_ATTEMPT_PASSWORD_RESET_REQUEST);
      expect(rows[0].identifier).toBe('ghost@example.com');
    });

    test('repeated requests in the same window coalesce into one bucket', async () => {
      const telemetry = new InMemoryAuthAttemptTelemetryRepository();
      const useCase = new RequestPasswordResetUseCase(
        userRepo, tokenRepo, tokenGenerator, notifier,
        { repo: telemetry, windowSizeMs: WINDOW_MS },
      );

      await useCase.execute(Email.create(TEST_EMAIL), { ipAddress: '203.0.113.7' });
      await useCase.execute(Email.create(TEST_EMAIL), { ipAddress: '203.0.113.7' });

      const rows = await telemetry.findAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].attemptCount).toBe(2);
    });

    test('no telemetry config: request still succeeds and records nothing', async () => {
      const useCase = new RequestPasswordResetUseCase(userRepo, tokenRepo, tokenGenerator, notifier);
      const result = await useCase.execute(Email.create(TEST_EMAIL), {});
      expect(result.success).toBe(true);
    });

    test('a telemetry failure does NOT fail the request and is logged', async () => {
      const throwing = { record: jest.fn().mockRejectedValue(new Error('telemetry db down')) } as never;
      const logger = { warn: jest.fn() };
      const useCase = new RequestPasswordResetUseCase(
        userRepo, tokenRepo, tokenGenerator, notifier,
        { repo: throwing, windowSizeMs: WINDOW_MS }, logger,
      );

      const result = await useCase.execute(Email.create(TEST_EMAIL), {});

      expect(result.success).toBe(true);
      expect(logger.warn).toHaveBeenCalled();
    });

    test('records under the unknown-origin sentinel when no request context is supplied', async () => {
      const telemetry = new InMemoryAuthAttemptTelemetryRepository();
      const useCase = new RequestPasswordResetUseCase(
        userRepo, tokenRepo, tokenGenerator, notifier,
        { repo: telemetry, windowSizeMs: WINDOW_MS },
      );

      await useCase.execute(Email.create(TEST_EMAIL));

      const rows = await telemetry.findAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].identifier).toBe(TEST_EMAIL);
      expect(rows[0].ipAddress).toBe(UNKNOWN_IP);
      expect(rows[0].userAgent).toBeNull();
    });
  });

  test('adds no further padding when the work already outlasts the constant-time floor', async () => {
    (userRepo.findByEmail as jest.Mock).mockImplementation(
      async () => new Promise((resolve) => {
        setTimeout(() => resolve(createTestUser()), 600);
      }),
    );
    const useCase = new RequestPasswordResetUseCase(userRepo, tokenRepo, tokenGenerator, notifier);

    const startedAt = Date.now();
    const result = await useCase.execute(Email.create(TEST_EMAIL));
    const elapsed = Date.now() - startedAt;

    expect(result.success).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(1100);
  });
});
