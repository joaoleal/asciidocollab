import Fastify from 'fastify';
import { ConfirmEmailChangeUseCase } from '@asciidocollab/domain';
import { emailConfirmRoute } from '../../../../src/routes/auth/email/confirm';
import { decorateApp } from '../../../helpers/decorate-app';

const USER_ID = '550e8400-e29b-41d4-a716-446655440022';

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function buildApp() {
  const save = jest.fn().mockResolvedValue(undefined);
  const app = Fastify();
  decorateApp(app, 'config', { auth: { emailConfirm: { rateLimitMax: 100, rateLimitWindow: 60_000 } } });
  decorateApp(app, 'repos', { emailChangeToken: {}, user: {}, auditLog: { save } });
  decorateApp(app, 'services', { tokenGenerator: {} });
  app.register(emailConfirmRoute);
  return { app, save };
}

afterEach(() => jest.restoreAllMocks());

describe('GET /auth/email/confirm', () => {
  it('returns 200 on a valid token (audit recording is owned by the use case)', async () => {
    jest.spyOn(ConfirmEmailChangeUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { userId: { value: USER_ID }, previousEmail: 'old@example.com', newEmail: 'new@example.com' },
    } as never);

    const { app } = buildApp();
    const response = await app.inject({ method: 'GET', url: '/auth/email/confirm?token=valid-token' });
    await flush();

    expect(response.statusCode).toBe(200);
  });

  it('returns 400 on an invalid token', async () => {
    jest.spyOn(ConfirmEmailChangeUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: { name: 'InvalidTokenError', message: 'bad token' },
    } as never);

    const { app } = buildApp();
    const response = await app.inject({ method: 'GET', url: '/auth/email/confirm?token=bad' });
    await flush();

    expect(response.statusCode).toBe(400);
  });
});
