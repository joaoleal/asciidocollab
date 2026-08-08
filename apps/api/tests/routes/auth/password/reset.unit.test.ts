import Fastify from 'fastify';
import { ResetPasswordUseCase, PasswordReuseError } from '@asciidocollab/domain';
import { passwordResetRoute } from '../../../../src/routes/auth/password/reset';
import { decorateApp } from '../../../helpers/decorate-app';

function buildTestServer() {
  const app = Fastify();
  decorateApp(app, 'repos', {
    user: { findById: jest.fn() },
    passwordResetToken: { findByTokenHash: jest.fn() },
  });
  decorateApp(app, 'services', {
    passwordHasher: { hash: jest.fn() },
    tokenGenerator: { hashToken: jest.fn() },
  });
  decorateApp(app, 'config', {
    auth: {
      passwordReset: { rateLimitMax: 100, rateLimitWindow: 60_000 },
      password: { historyDepth: 3 },
    },
  });
  app.register(passwordResetRoute);
  return app;
}

afterEach(() => jest.restoreAllMocks());

describe('POST /auth/password/reset (unit)', () => {
  it('returns 400 PASSWORD_REUSE when new password was recently used', async () => {
    jest.spyOn(ResetPasswordUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new PasswordReuseError('Cannot reuse recent passwords'),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      payload: { token: 'some-token', newPassword: 'P@ssword123!' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('PASSWORD_REUSE');
  });

  it('returns 200 on successful password reset', async () => {
    jest.spyOn(ResetPasswordUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { userId: { value: '550e8400-e29b-41d4-a716-446655440099' } },
    } as never);

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      payload: { token: 'valid-token', newPassword: 'P@ssword123!' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).message).toBe('Password reset successfully');
  });
});
