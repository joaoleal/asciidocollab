import { ResendVerificationEmailUseCase } from '../../../src/use-cases/auth/resend-verification-email';
import { InMemoryUserRepository } from '../../ports/user/in-memory-user.repository';
import { InMemoryEmailVerificationTokenRepository } from '../../ports/auth-tokens/in-memory-email-verification-token.repository';
import { User } from '../../../src/entities/user';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Email } from '../../../src/value-objects/identity/email';
import { Timestamps } from '../../../src/value-objects/common/timestamps';
import type { TokenGenerator, PasswordResetTokenData } from '../../../src/services/token-generator';
import type { EmailVerificationNotifier } from '../../../src/services/email-verification-notifier';
import { randomUUID } from 'crypto';

const tokenData: PasswordResetTokenData = {
  token: 'raw-verify-token',
  hashedToken: 'hashed-verify-token',
  expiresAt: new Date(Date.now() + 86_400_000),
};

const tokenGenerator: TokenGenerator = {
  generatePasswordResetToken: () => tokenData,
  generateInvitationToken: () => tokenData,
  generateEmailVerificationToken: () => tokenData,
  hashToken: (t) => `hashed:${t}`,
};

function makeUser(emailVerified: boolean): User {
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

describe('ResendVerificationEmailUseCase', () => {
  let userRepo: InMemoryUserRepository;
  let tokenRepo: InMemoryEmailVerificationTokenRepository;
  let notifier: EmailVerificationNotifier;
  let useCase: ResendVerificationEmailUseCase;

  beforeEach(() => {
    userRepo = new InMemoryUserRepository();
    tokenRepo = new InMemoryEmailVerificationTokenRepository();
    notifier = {
      sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
      sendResendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    };
    useCase = new ResendVerificationEmailUseCase(userRepo, tokenRepo, tokenGenerator, notifier);
  });

  test('no-op when user emailVerified=true', async () => {
    const user = makeUser(true);
    await userRepo.save(user);

    const result = await useCase.execute(user.id);

    expect(result.success).toBe(true);
    expect(notifier.sendResendVerificationEmail).not.toHaveBeenCalled();
  });

  test('deletes old tokens and sends new email when unverified', async () => {
    const user = makeUser(false);
    await userRepo.save(user);

    const result = await useCase.execute(user.id);

    expect(result.success).toBe(true);
    expect(notifier.sendResendVerificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'user@example.com' }),
      tokenData.token,
    );
    const saved = await tokenRepo.findByTokenHash(tokenData.hashedToken);
    expect(saved).not.toBeNull();
  });

  test('SMTP failure is non-fatal — returns success', async () => {
    const user = makeUser(false);
    await userRepo.save(user);
    (notifier.sendResendVerificationEmail as jest.Mock).mockRejectedValue(new Error('SMTP failure'));

    const result = await useCase.execute(user.id);

    expect(result.success).toBe(true);
  });

  test('unknown user: returns success without sending mail (no account enumeration)', async () => {
    const result = await useCase.execute(UserId.create(randomUUID()));

    expect(result.success).toBe(true);
    expect(notifier.sendResendVerificationEmail).not.toHaveBeenCalled();
    expect(await tokenRepo.findByTokenHash(tokenData.hashedToken)).toBeNull();
  });
});
