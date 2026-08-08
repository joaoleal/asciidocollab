import Fastify from 'fastify';
import { ChangePasswordUseCase } from '@asciidocollab/domain';
import { passwordChangeRoute } from '../../../../src/routes/auth/password/change';
import { decorateApp } from '../../../helpers/decorate-app';

function buildTestServer() {
  const app = Fastify();
  app.addHook('preHandler', (request, _reply, done) => {
    (request as never as { session: { userId: string } }).session = {
      userId: '550e8400-e29b-41d4-a716-446655440001',
    };
    done();
  });
  decorateApp(app, 'repos', {
    user: { findById: jest.fn().mockResolvedValue(null) },
  });
  decorateApp(app, 'services', {
    passwordHasher: { hash: jest.fn(), verify: jest.fn() },
    breachChecker: { isBreached: jest.fn().mockResolvedValue(false) },
    emailSender: { send: jest.fn().mockResolvedValue(undefined) },
  });
  decorateApp(app, 'config', {
    auth: {
      passwordChange: { rateLimitMax: 100, rateLimitWindow: 60_000 },
      password: { historyDepth: 3 },
      email: { templates: { passwordChanged: { subject: 'changed', html: '<p>changed</p>' } } },
    },
  });
  app.register(passwordChangeRoute);
  return app;
}

afterEach(() => jest.restoreAllMocks());

describe('POST /auth/password/change (unit)', () => {
  it('returns 400 VALIDATION_ERROR for an unrecognised error type (default switch case)', async () => {
    jest.spyOn(ChangePasswordUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: Object.assign(new Error('some weird error'), { name: 'SomeUnknownError' }) as never,
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/password/change',
      payload: { currentPassword: 'OldP@ss1', newPassword: 'NewP@ss1' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('VALIDATION_ERROR');
  });
});
