// Domain unit tests for RequestEmailChangeUseCase
import { RequestEmailChangeUseCase } from '../../../src/use-cases/auth/request-email-change';
import { User } from '../../../src/entities/user';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Email } from '../../../src/value-objects/identity/email';
import { Timestamps } from '../../../src/value-objects/common/timestamps';
import { EmailChangeToken } from '../../../src/entities/email-change-token';
import { EmailChangeTokenId } from '../../../src/value-objects/ids/email-change-token-id';
import { InMemoryEmailChangeTokenRepository } from '../../ports/auth-tokens/in-memory-email-change-token.repository';
import { UserRepository } from '../../../src/ports/user/user.repository';
import { TokenGenerator } from '../../../src/services/token-generator';
import { EmailChangeNotifier } from '../../../src/services/email-change-notifier';
import { NotificationDeliveryError } from '../../../src/errors/common/notification-delivery';

const USER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440000');
const CURRENT_EMAIL = 'user@example.com';

function createTestUser(email = CURRENT_EMAIL): User {
  return new User(
    USER_ID,
    Email.create(email),
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

function makeNotifier(): jest.Mocked<EmailChangeNotifier> {
  return { sendConfirmationEmail: jest.fn().mockResolvedValue(undefined) };
}

describe('RequestEmailChangeUseCase', () => {
  let tokenRepo: InMemoryEmailChangeTokenRepository;
  let userRepo: UserRepository;
  let tokenGenerator: TokenGenerator;
  let notifier: jest.Mocked<EmailChangeNotifier>;
  let useCase: RequestEmailChangeUseCase;

  beforeEach(() => {
    tokenRepo = new InMemoryEmailChangeTokenRepository();
    const testUser = createTestUser();
    userRepo = {
      findById: jest.fn().mockResolvedValue(testUser),
      findByEmail: jest.fn().mockResolvedValue(null),
      save: jest.fn(),
      hasAny: jest.fn(),
    } as unknown as UserRepository;
    tokenGenerator = makeTokenGenerator();
    notifier = makeNotifier();
    useCase = new RequestEmailChangeUseCase(userRepo, tokenRepo, tokenGenerator, notifier);
  });

  test('happy path: creates token and sends confirmation email', async () => {
    const result = await useCase.execute(USER_ID, 'new@example.com');
    expect(result.success).toBe(true);
    const active = await tokenRepo.findActiveByUserId(USER_ID);
    expect(active).not.toBeNull();
    expect(active?.pendingEmail).toBe('new@example.com');
    expect(notifier.sendConfirmationEmail).toHaveBeenCalledWith('new@example.com', 'raw-token');
  });

  test('supersedes existing active token and sends new confirmation', async () => {
    const oldToken = new EmailChangeToken(
      EmailChangeTokenId.create('550e8400-e29b-41d4-a716-446655440001'),
      USER_ID,
      'old-hash',
      'old@example.com',
      new Date(Date.now() + 3_600_000),
      null,
    );
    await tokenRepo.save(oldToken);

    const result = await useCase.execute(USER_ID, 'newer@example.com');
    expect(result.success).toBe(true);

    const byOldHash = await tokenRepo.findByTokenHash('old-hash');
    expect(byOldHash).toBeNull();

    const active = await tokenRepo.findActiveByUserId(USER_ID);
    expect(active?.pendingEmail).toBe('newer@example.com');
    expect(notifier.sendConfirmationEmail).toHaveBeenCalledWith('newer@example.com', 'raw-token');
  });

  test('email already registered: returns success, notifier not called (enumeration prevention)', async () => {
    (userRepo.findByEmail as jest.Mock).mockResolvedValue(createTestUser('new@example.com'));
    const result = await useCase.execute(USER_ID, 'new@example.com');
    expect(result.success).toBe(true);
    const active = await tokenRepo.findActiveByUserId(USER_ID);
    expect(active).toBeNull();
    expect(notifier.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  test('newEmail equals current email: returns success, notifier not called (noop)', async () => {
    const result = await useCase.execute(USER_ID, CURRENT_EMAIL);
    expect(result.success).toBe(true);
    const active = await tokenRepo.findActiveByUserId(USER_ID);
    expect(active).toBeNull();
    expect(notifier.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  test('SMTP failure: notifier throws, propagates as NotificationDeliveryError', async () => {
    notifier.sendConfirmationEmail.mockRejectedValue(new Error('SMTP down'));
    await expect(useCase.execute(USER_ID, 'new@example.com')).rejects.toThrow(NotificationDeliveryError);
  });
});
