import Fastify from 'fastify';
import {
  User,
  UserId,
  Email,
  Timestamps,
  PasswordResetToken,
  PasswordResetTokenId,
} from '@asciidocollab/domain';
import { passwordResetRoute } from '../../../../src/routes/auth/password/reset';
import { setupTestEnvironment } from '../../../helpers/test-environment';
import { randomUUID } from 'crypto';
import { decorateApp } from '../../../helpers/decorate-app';
import type { FastifyBaseLogger } from 'fastify';

// Pin the password policy (buildPasswordPolicy reads the global getConfig() singleton)
// so this test does not break if a schema default changes or another test's config leaks.
beforeAll(() => {
  setupTestEnvironment();
  process.env.ASCIIDOCOLLAB_AUTH_PASSWORD_MIN_LENGTH = '8';
  process.env.ASCIIDOCOLLAB_AUTH_PASSWORD_REQUIRE_UPPERCASE = 'true';
  process.env.ASCIIDOCOLLAB_AUTH_PASSWORD_REQUIRE_LOWERCASE = 'true';
  process.env.ASCIIDOCOLLAB_AUTH_PASSWORD_REQUIRE_DIGITS = 'true';
  process.env.ASCIIDOCOLLAB_AUTH_PASSWORD_REQUIRE_SYMBOLS = 'true';
});

const RAW_TOKEN = 'raw-token';
const TOKEN_HASH = 'hashed-raw-token';

/** A Fastify-compatible logger that records `warn` calls (loggerInstance pattern). */
function makeRecordingLogger(): { logger: FastifyBaseLogger; warn: jest.Mock } {
  const warn = jest.fn();
  const logger: FastifyBaseLogger = {
    level: 'info',
    fatal: jest.fn(), error: jest.fn(), warn, info: jest.fn(), debug: jest.fn(), trace: jest.fn(), silent: jest.fn(),
    child: () => logger,
  };
  return { logger, warn };
}

/**
 * Builds an app running the REAL ResetPasswordUseCase (not a mock) so the route's
 * logger wiring is exercised end-to-end. The audit repo's `save` is provided by
 * the caller so we can make it fail.
 */
function buildApp(auditSave: jest.Mock, logger: FastifyBaseLogger) {
  const userId = UserId.create(randomUUID());
  const user = new User(
    userId, Email.create('user@example.com'), 'Test', 'old-hash', [], null, null, false, new Timestamps(), true, 'SELF_REGISTERED',
  );
  const token = new PasswordResetToken(
    PasswordResetTokenId.create(randomUUID()), userId, TOKEN_HASH, new Date(Date.now() + 3_600_000), null, new Date(),
  );

  const app = Fastify({ loggerInstance: logger });
  decorateApp(app, 'config', {
    auth: { passwordReset: { rateLimitMax: 100, rateLimitWindow: 60_000 }, password: { historyDepth: 5 } },
  });
  decorateApp(app, 'repos', {
    user: { findById: jest.fn().mockResolvedValue(user), save: jest.fn() },
    passwordResetToken: { findByTokenHash: jest.fn().mockResolvedValue(token), markAsUsed: jest.fn() },
    auditLog: { save: auditSave },
  });
  decorateApp(app, 'services', {
    passwordHasher: { hash: jest.fn().mockResolvedValue('new-hash'), verify: jest.fn().mockResolvedValue(false) },
    tokenGenerator: { hashToken: jest.fn().mockReturnValue(TOKEN_HASH) },
  });
  app.register(passwordResetRoute);
  return app;
}

const VALID_PAYLOAD = { token: RAW_TOKEN, newPassword: 'NewP@ssw0rd123!' };

describe('POST /auth/password/reset — audit observability (best-effort)', () => {
  it('still succeeds (200) when the audit write fails — the failure reason is business-only', async () => {
    const { logger } = makeRecordingLogger();
    const app = buildApp(jest.fn().mockRejectedValue(new Error('audit db down')), logger);

    const response = await app.inject({ method: 'POST', url: '/auth/password/reset', payload: VALID_PAYLOAD });

    // A downed audit store must NOT fail the reset (the token is single-use; failing
    // would be unrecoverable). The result reflects the business outcome only.
    expect(response.statusCode).toBe(200);
  });

  it('logs the swallowed audit failure (observable, not silent)', async () => {
    const { logger, warn } = makeRecordingLogger();
    const app = buildApp(jest.fn().mockRejectedValue(new Error('audit db down')), logger);

    await app.inject({ method: 'POST', url: '/auth/password/reset', payload: VALID_PAYLOAD });

    // The route must wire a logger into the use case so the best-effort swallow is
    // observable. Assert the SPECIFIC audit-failure log (not just "some warn"), so the
    // test can't pass on an unrelated warn and catches a regression that drops it.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.anything() }),
      'failed to record audit event',
    );
  });
});
