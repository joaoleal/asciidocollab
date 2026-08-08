import Fastify from 'fastify';
import { logoutRoute } from '../../../src/routes/auth/logout';
import { decorateApp } from '../../helpers/decorate-app';

const USER_ID = '550e8400-e29b-41d4-a716-446655440010';

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function buildApp(userId: string | undefined) {
  const save = jest.fn().mockResolvedValue(undefined);
  const app = Fastify();
  app.decorateReply('clearCookie', function clearCookie() {
    return this;
  });
  app.addHook('onRequest', (request, _reply, done) => {
    (request as unknown as { session: { userId?: string; destroy: (callback: (error?: unknown) => void) => void } }).session = {
      userId,
      destroy: (callback) => callback(),
    };
    done();
  });
  decorateApp(app, 'repos', { auditLog: { save } });
  app.register(logoutRoute);
  return { app, save };
}

describe('POST /auth/logout', () => {
  it('logs out and records auth.signed_out best-effort for the prior actor', async () => {
    const { app, save } = buildApp(USER_ID);
    const response = await app.inject({ method: 'POST', url: '/auth/logout' });
    await flush();

    expect(response.statusCode).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    const rec = save.mock.calls[0][0];
    expect(rec.action).toBe('auth.signed_out');
    expect(rec.userId.value).toBe(USER_ID);
  });

  it('does not record when there was no authenticated session', async () => {
    const { app, save } = buildApp(undefined);
    const response = await app.inject({ method: 'POST', url: '/auth/logout' });
    await flush();

    expect(response.statusCode).toBe(200);
    expect(save).not.toHaveBeenCalled();
  });
});
