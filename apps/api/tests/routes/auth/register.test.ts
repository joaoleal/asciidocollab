import Fastify from 'fastify';
import { RegisterUseCase } from '@asciidocollab/domain';
import { registerRoute } from '../../../src/routes/auth/register';
import { decorateApp } from '../../helpers/decorate-app';

function buildTestServer() {
  const app = Fastify();
  decorateApp(app, 'repos', {
    user: { findByEmail: jest.fn(), save: jest.fn() },
    systemSetting: { get: jest.fn() },
    emailVerificationToken: { save: jest.fn() },
  });
  decorateApp(app, 'services', {
    commonPasswordChecker: { isCommon: jest.fn() },
    breachChecker: { isBreached: jest.fn() },
    passwordHasher: { hash: jest.fn() },
    tokenGenerator: { generateEmailVerificationToken: jest.fn() },
    emailVerificationNotifier: { sendVerificationEmail: jest.fn() },
  });
  decorateApp(app, 'config', {
    auth: { registration: { rateLimitMax: 100, rateLimitWindow: 60_000 } },
  });
  app.register(registerRoute);
  return app;
}

afterEach(() => jest.restoreAllMocks());

describe('POST /auth/register — email verification paths', () => {
  it('returns 202 with requiresEmailVerification:true when emailSent=true', async () => {
    jest.spyOn(RegisterUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: {
        userId: { value: 'user-id-123' } as never,
        isFirstUser: false,
        emailSent: true,
      },
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'user@example.com', password: 'Password1!', displayName: 'Test' },
    });

    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body);
    expect(body.requiresEmailVerification).toBe(true);
    expect(body.message).toMatch(/check your email/i);
  });

  it('returns 202 with anti-enumeration message when emailSent=false', async () => {
    jest.spyOn(RegisterUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: {
        userId: { value: 'user-id-456' } as never,
        isFirstUser: false,
        emailSent: false,
      },
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'duplicate@example.com', password: 'Password1!', displayName: 'Test' },
    });

    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body);
    expect(body.requiresEmailVerification).toBeUndefined();
    expect(body.message).toMatch(/if this address/i);
  });
});
